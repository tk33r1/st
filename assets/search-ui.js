/** 共通検索。操作と状態は共通、カードと装飾はページが受け持つ。 */
(function(w) {
  'use strict';
  const words={
    ja:{input:'検索語',submit:'検索',clear:'検索をやめる',sort:'並べ替え',allOption:'すべて',placeholder:'サイト内を検索',
      search:q=>`「${q}」で検索`,heading:(q,n)=>`「${q}」の検索結果${n===null?'':` ${n}件`}`,
      notice:'Enter で検索。検索語を TypeSafe AI に送り、関連する候補も探します',noticeOff:'Enter で検索',
      loading:'読み込み中…',baseFailed:'検索の準備に失敗しました。ページを再読み込みしてください。',
      preparing:'（読み込み中）',readingFailed:'（文字の一致のみ）',updated:n=>`読みがなの一致を含めて${n}件になりました`,
      ranking:'AIで関連する候補を探しています…',semantic:'AIが見つけた関連候補',showAll:'すべて表示',retry:'AIで関連する候補も探す',
      related:q=>`「${q}」に一致するものはありませんが、近いものがあります`,none:q=>`「${q}」に一致するものは見つかりませんでした`,
      textNone:q=>`「${q}」に文字で一致するものは見つかりませんでした`,more:n=>`もっと見る（残り ${n}件）`,
      found:n=>`AIが関連する候補を${n}件見つけました`,failed:'AI検索を利用できません。',limited:'AI検索の利用上限に達しました。',
      disabled:'AI検索は停止中です。',updating:'検索データを更新しています。',close:'閉じる',privacyTitle:'検索とプライバシー',
      analytics:'検索語は Google アナリティクスに記録します。メールアドレスや電話番号は伏せてから送ります。アクセス解析を止めれば送信しません。',privacy:'検索ボタン／Enterで、検索語と公開済みの候補情報をTypeSafe AIへ送ります。入力中・絞り込み・追加表示ではTypeSafe AIへ送りません。候補を開くと、検索語と開いたページを並び順の改善のために記録します。ファイルやツールの処理内容は送りません。',
      privacyDetails:'TypeSafe AI（Jev）の入力はモデルの学習に使われません。保持期間は明示されていません。米国のサーバーで処理されます。利用回数の制限のためIPアドレスを記録します。候補を開いたときの検索語・開いたページ・一覧の順位はサイトのDBに90日間記録し、並び順の改善に使います（IPアドレスは元に戻せないハッシュにして残します）。同じ検索語で3人以上が開いたページは、検索語と人数を集計して公開データに含めます。',privacyLink:'TypeSafe AIのプライバシーポリシー'},
    en:{input:'Search query',submit:'Search',clear:'Clear search',sort:'Sort',allOption:'All',placeholder:'Search this site',
      search:q=>`Search for “${q}”`,heading:(q,n)=>n===null?`Results for “${q}”`:`${n} results for “${q}”`,
      notice:'Press Enter to search. Your query is also sent to TypeSafe AI to find related results',noticeOff:'Press Enter to search',
      loading:'Loading…',baseFailed:'Search could not be prepared. Please reload the page.',preparing:'(loading)',readingFailed:'(text matches only)',updated:n=>`Updated: ${n} results`,
      ranking:'Looking for related results with AI…',semantic:'Related results found by AI',showAll:'Show all',retry:'Find related results with AI',
      related:q=>`No exact matches for “${q}”, but these look related`,none:q=>`No results for “${q}”`,textNone:q=>`No text matches for “${q}”`,more:n=>`Show more (${n} left)`,
      found:n=>`AI found ${n} related results`,failed:'AI search is unavailable.',limited:'AI search has reached its usage limit.',disabled:'AI search is disabled.',
      updating:'Search data is updating.',close:'Close',privacyTitle:'Search and privacy',
      analytics:'Search terms are recorded in Google Analytics. Email addresses and phone numbers are masked before sending. Turning analytics off stops this transmission.',privacy:'Search / Enter sends your query and public candidate information to TypeSafe AI. Typing, filters and additional pages do not send it to TypeSafe AI. When you open a result, your query and the page you opened are recorded to improve the ranking. Files and tool processing contents are not sent.',
      privacyDetails:'TypeSafe AI (Jev) inputs are not used for model training. The retention period is not specified. Processing takes place on servers in the United States. Your IP is recorded to limit usage. When you open a result, the query, the page and its position are stored in the site database for 90 days to improve the ranking (your IP is kept only as a salted hash that cannot be reversed). When three or more people open the same page for the same query, the query and the count are published in aggregated form.',privacyLink:'TypeSafe AI privacy policy'}
  };
  let serial=0;
  const hash=/^[a-f0-9]{64}$/;
  function safeHref(value, scope) {
    if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\u0000- \u007f]/.test(value)
      || /%(?![a-f0-9]{2})/i.test(value) || /%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw new Error('search_href');
    let decoded;try {decoded=decodeURIComponent(value);} catch(_) {throw new Error('search_href');}
    if (/[\\\u0000- \u007f]/.test(decoded)) throw new Error('search_href');
    const url = new URL(value, 'https://tk.st');
    if (url.origin !== 'https://tk.st' || url.search || url.pathname + url.hash !== value
      || (scope === 'tools' && !value.startsWith('/tools/')) || (scope === 'game' && !value.startsWith('/game/'))) throw new Error('search_href');
    return value;
  }

  function mount(container,adapter) {
    if(!container || !adapter || typeof adapter.loadBase!=='function' || typeof adapter.loadReadings!=='function'
      || typeof adapter.href!=='function' || !['site','tools','game','nitori','retail'].includes(adapter.scope)) throw new Error('search_adapter');
    if(container.dataset.stSearchMounted) throw new Error('search_mounted');
    container.dataset.stSearchMounted='1';container.classList.add('st-search');
    const id=`st-search-${++serial}`,controller=new AbortController(),signal=controller.signal;
    const client=w.STSiteSearch.createRankClient({scope:adapter.scope});
    let locale=adapter.locale==='en'?'en':'ja',engine=null,base=null,links=new Map(),records=new Map(),parts=null;
    let dataRevision=0,loadingRevision=0,conditionRevision=0,destroyed=false,composing=false,imeEnterHeld=false;
    let baseState='loading',readingState='unfetched',rankState='idle',rankRows=[],rankComplete=false;
    let recoveryAttempted=false,recoveryPromise=null,committed='',limit=20,activeSuggestion=-1;
    let dropdown=false,expandedAI=false,pending=null,matched={rows:[],total:0},dedupeIds=new Set(),confirmation=0;
    const sorts=adapter.sorts || [],catalogueSort=sorts.find(s=>s.value==='newest')?.value || sorts.find(s=>s.value!=='relevance')?.value || '';
    let selectedSort=catalogueSort,lookupSort=catalogueSort,previousSort=catalogueSort,announcedLocal='',announcedRank='';
    const filters={},controls=new Map(),filterLabels=new Map(),chipAreas=new Map(),labelled=[];
    const node=(tag,className,parent)=>{const n=document.createElement(tag);if(className) n.className=className;if(parent) parent.append(n);return n;};
    const classes=(n,key)=>{if(adapter.classes?.[key]) n.classList.add(...adapter.classes[key].split(/\s+/).filter(Boolean));return n;};
    const textFor=key=>typeof key==='string'?words[locale][key]:(locale==='en' && (key.label_en || key.en) || key.label || key.ja);
    const labelText=(key,n)=>{labelled.push([key,n]);n.textContent=textFor(key);};
    const button=(key,parent)=>{const n=node('button','st-search-button',parent);n.type='button';if(key) labelText(key,n);return n;};
    const call=(name,value)=>{try{adapter[name]?.(value);}catch(_){}};
    const track=(event,values)=>{try{adapter.track?.(event,values);}catch(_){}};
    const activeFilters=()=>Object.fromEntries(Object.entries(filters).filter(([,v])=>v));
    const keyOf=value=>w.STJapaneseSearch.normalize(value).trim();
    const rankCondition=()=>({query:committed,locale,filters:activeFilters(),generation:base?.generation});
    const notify=()=>call('onConditions',{...rankCondition(),sort:selectedSort});
    // 表示: 既存ヘッダーを借りる場合も操作の受け口はここに一本化する。
    const external=!!adapter.input,form=adapter.input || node('form','st-search-form',container);
    form.setAttribute('role','search');form.dataset.stSearchOwned='1';
    // 借りた欄は DOM の中で動かさない。動かすとフォーカスと IME の変換が途切れるので、候補の枠だけを直後に置く。
    const component=node('div',external?'st-search-control st-search-control-external':'st-search-control',null);
    if(external) form.after(component);else {container.append(component);component.append(form);}
    const focusRoot=external?form:component,inside=n=>!!n && (form.contains(n) || component.contains(n));
    const box=external?form:node('div','st-search-input-row',form);
    const input=external?form.querySelector('input[type="search"]'):node('input','st-search-input',box);
    input.classList.add('st-search-input');classes(input,'input');if(input.type!=='search') input.type='search';input.id ||= id+'-input';input.maxLength=400;
    input.autocomplete='off';input.spellcheck=false;input.setAttribute('enterkeyhint','search');input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
    const label=external?form.querySelector('label') || node('label','',form):node('label','',form);
    label.classList.add('st-search-label');label.htmlFor=input.id;labelText('input',label);
    const submit=external?form.querySelector('button[type="submit"]'):button(null,box);
    submit.classList.add('st-search-submit');classes(submit,'button');submit.type='submit';
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx','10');circle.setAttribute('cy','10');circle.setAttribute('r','6');
    const line=document.createElementNS(svg.namespaceURI,'path');line.setAttribute('d','m15 15 6 6');svg.append(circle,line);submit.replaceChildren(svg);
    const clear=button(null,null);clear.classList.add('st-search-clear');clear.textContent='×';submit.before(clear);
    const suggestArea=classes(node('div','st-search-suggestions',component),'panel');suggestArea.hidden=true;
    const suggestions=node('ul','st-search-list',suggestArea);suggestions.id=id+'-suggestions';suggestions.setAttribute('role','listbox');suggestions.dataset.stSearchList='suggest';
    input.setAttribute('aria-controls',suggestions.id);input.setAttribute('aria-expanded','false');
    const suggestionMessage=node('p','st-search-suggestion-message',suggestArea);
    const footer=node('div','st-search-notice',suggestArea),notice=node('span','',footer);
    const info=button(null,footer);info.classList.add('st-search-info');info.textContent='ⓘ';info.setAttribute('aria-haspopup','dialog');
    const results=adapter.results || node('div','st-search-results',container);results.classList.add('st-search-results');
    const filterArea=node('div','st-search-filters',results);
    for(const spec of adapter.filters || []) {
      const allowed={site:[],tools:['category'],game:['genre'],nitori:['category','region','month'],retail:['category','region','month']};
      if(!spec || !allowed[adapter.scope].includes(spec.key) || !Array.isArray(spec.options) || controls.has(spec.key)) throw new Error('search_filters');
      const l=node(adapter.filterChips?'div':'label','',filterArea),text=node('span','',l),select=node('select','',l);labelText(spec,text);select.dataset.filter=spec.key;
      for(const choice of spec.options) {const option=node('option','',select);option.value=choice.value;labelText(choice,option);}
      filters[spec.key]=select.value;controls.set(spec.key,select);filterLabels.set(spec.key,l);
      select.addEventListener('change',()=>{filters[spec.key]=select.value;changeFilter();},{signal});
      if(adapter.filterChips) {
        text.id=id+'-filter-'+spec.key;l.setAttribute('role','group');l.setAttribute('aria-labelledby',text.id);select.setAttribute('aria-labelledby',text.id);
        select.hidden=true;const chips=node('div','st-search-chips',l);chipAreas.set(spec.key,chips);
      }
    }
    let sortSelect=null;
    if(sorts.length>1) {
      const l=node('label','',filterArea);labelText('sort',node('span','',l));sortSelect=node('select','',l);sortSelect.dataset.sort='1';
      sortSelect.addEventListener('change',()=>{selectedSort=sortSelect.value;if(!committed) previousSort=selectedSort;limit=20;refreshLocal(false);refreshSuggestions();notify();},{signal});
    }
    const local=node('section','st-search-local',results),localHeading=node('h3','st-search-heading',local);
    const semantic=node('section','st-search-semantic',local),semanticHeading=node('h4','st-search-heading',semantic);
    const rankList=node('ul','st-search-list',semantic);rankList.dataset.stSearchList='semantic';
    const showAll=button('showAll',semantic),retryArea=node('div','st-search-retry-area',semantic),retry=button('retry',retryArea);
    const retryInfo=button(null,retryArea);retryInfo.classList.add('st-search-info');retryInfo.textContent='ⓘ';retryInfo.setAttribute('aria-haspopup','dialog');
    const resultMessage=node('p','st-search-empty',local),localList=classes(node('ul','st-search-list',local),'list');localList.dataset.stSearchList='local';
    const more=button(null,local);more.classList.add('st-search-more');
    const dataStatus=node('p','st-search-data-status st-search-visually-hidden',results),rankStatus=node('p','st-search-rank-status st-search-visually-hidden',results);
    dataStatus.setAttribute('role','status');rankStatus.setAttribute('role','status');
    const dialog=node('dialog','st-search-privacy-details',container);dialog.setAttribute('aria-labelledby',id+'-privacy-title');
    const dialogHead=node('div','st-search-dialog-head',dialog),dialogTitle=node('h2','',dialogHead);dialogTitle.id=id+'-privacy-title';labelText('privacyTitle',dialogTitle);
    const close=button('close',dialogHead);labelText('privacy',node('p','',dialog));labelText('privacyDetails',node('p','',dialog));
    if(adapter.analyticsNotice) labelText('analytics',node('p','st-search-analytics-notice',dialog));
    const policy=node('a','',dialog);policy.href='https://typesafe.ai/legal/privacy-policy';labelText('privacyLink',policy);
    let returnFocus=null;
    function openPrivacy(origin=info) {returnFocus=origin===info?input:origin;closeDropdown();dialog.showModal();}
    info.addEventListener('click',()=>openPrivacy(info),{signal});retryInfo.addEventListener('click',()=>openPrivacy(retryInfo),{signal});
    close.addEventListener('click',()=>dialog.close(),{signal});dialog.addEventListener('click',e=>{if(e.target===dialog) dialog.close();},{signal});
    dialog.addEventListener('close',()=>returnFocus?.focus(),{signal});
    function updateLabels() {
      labelled.forEach(([key,n])=>{n.textContent=textFor(key);});input.placeholder=adapter.placeholder?textFor(adapter.placeholder):words[locale].placeholder;
      submit.setAttribute('aria-label',words[locale].submit);clear.setAttribute('aria-label',words[locale].clear);
      info.setAttribute('aria-label',words[locale].privacyTitle);retryInfo.setAttribute('aria-label',words[locale].privacyTitle);
      notice.textContent=client.disabled?words[locale].noticeOff:words[locale].notice;
    }
    function updateSort() {
      if(!sortSelect) return;sortSelect.replaceChildren();
      const order=['relevance','newest','oldest','title'];
      const choices=sorts.filter(s=>committed || s.value!=='relevance').slice().sort((a,b)=>{
        const x=order.indexOf(a.value),y=order.indexOf(b.value);return x<0 || y<0?0:x-y;
      });
      for(const choice of choices) {const option=node('option','',sortSelect);option.value=choice.value;option.textContent=textFor(choice);}sortSelect.value=selectedSort;
    }
    function showStates() {
      container.dataset.stSearchBase=baseState;container.dataset.stSearchReadings=readingState;
      clear.hidden=!input.value;submit.disabled=composing;
      for(const [key,l] of filterLabels) l.hidden=!committed && adapter.filtersBeforeSearch && !adapter.filtersBeforeSearch.includes(key);
      for(const [key,area] of chipAreas) for(const b of area.children) b.setAttribute('aria-pressed',String(b.dataset.value===filters[key]));
      local.hidden=!committed;
      call('onState',{base:baseState,readings:readingState,rank:rankState,total:matched.total,query:committed,composing,submitted:!!committed,complete:rankComplete});
    }
    function closeDropdown() {dropdown=false;suggestArea.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');activeSuggestion=-1;}
    function titleOf(record) {return record[adapter.displayFields?.[locale]?.title] || record[adapter.titleField || 'title'];}
    function highlight(parent,title,query) {
      // ASCII英字だけを小文字化する。読み・全角一致は強調しない。
      const fold=s=>s.replace(/[A-Z]/g,c=>c.toLowerCase()),hay=fold(title),needle=fold(query);let start=0,index=needle?hay.indexOf(needle):-1;
      while(index>=0) {parent.append(document.createTextNode(title.slice(start,index)));node('strong','',parent).textContent=title.slice(index,index+needle.length);start=index+needle.length;index=hay.indexOf(needle,start);}
      parent.append(document.createTextNode(title.slice(start)));
    }
    function compactItem(record,href,suggestion=false) {
      const a=node('a','',null);a.href=href;const title=node('span','st-search-title',a);
      if(suggestion) highlight(title,titleOf(record),input.value.trim());else title.textContent=titleOf(record);
      const kind=adapter.renderSuggestion?.(record,{href,locale});
      if(kind) {
        if(typeof kind==='string') node('span','st-search-kind',a).textContent=kind;
        else if(kind.classList?.contains('st-search-kind')) a.append(kind);
        else node('span','st-search-kind',a).append(kind);
      }
      return a;
    }
    function addRow(list,row,compact,index) {
      // href は prepareBase で検査済み。候補の枠と②の短い表示は共通の行、それ以外はページの描画に任せる。
      const record=row.record || records.get(row.id),href=links.get(record.id),suggestion=list===suggestions;
      let item;try {item=suggestion || compact?compactItem(record,href,suggestion):adapter.renderItem?.(record,{href,locale});}catch(_) {return;}
      if(!item) {item=compactItem(record,href);const desc=record[adapter.displayFields?.[locale]?.description] || record[adapter.descriptionField || 'description'] || '';if(desc) node('span','st-search-description',item).textContent=desc;}
      const primary=item.matches('a')?item:item.querySelector('[data-st-primary]');if(!primary || primary.getAttribute('href')!==href) return;
      primary.classList.add('st-search-link');primary.dataset.stPrimary='';const li=item.tagName==='LI'?item:node('li','',null);if(li!==item) li.append(item);
      li.classList.add('st-search-result');li.dataset.id=record.id;list.append(li);
      if(suggestion) {li.setAttribute('role','option');li.id=id+'-option-'+index;primary.tabIndex=-1;}
    }
    function fillList(list,rows,compact=false) {
      const old=[...list.children];let shared=0;while(shared<old.length && shared<rows.length && old[shared].dataset.id===rows[shared].id) shared++;
      for(let i=old.length-1;i>=shared;i--) old[i].remove();for(let i=shared;i<rows.length;i++) addRow(list,rows[i],compact,i);
    }
    function promote(result,query,sort=selectedSort) {
      const counts=sort && sort!=='relevance'?null:adapter.promoted?.(keyOf(query));if(!counts?.size) return result;
      const top=[],rest=[];for(const row of result.rows) (counts.has(links.get(row.id))?top:rest).push(row);top.sort((a,b)=>counts.get(links.get(b.id))-counts.get(links.get(a.id)));return {rows:[...top,...rest],total:result.total};
    }
    function refreshSuggestions() {
      if(destroyed) return;
      const query=input.value.trim();lookupSort='relevance';const suggested=engine && Array.from(keyOf(query)).length<=200?promote(engine.search(query,activeFilters()),query,'relevance'):{rows:[],total:0};
      suggestions.replaceChildren();const first=node('li','st-search-result st-search-submit-option',suggestions);first.id=id+'-search-option';first.setAttribute('role','option');
      node('span','st-search-search-for',first).textContent=words[locale].search(query);
      suggested.rows.slice(0,6).forEach((row,i)=>addRow(suggestions,row,true,i));
      suggestionMessage.textContent=baseState==='failed'?words[locale].baseFailed:baseState==='loading' || (!suggested.total && !['ready','failed'].includes(readingState))?words[locale].loading:'';
      suggestionMessage.hidden=!suggestionMessage.textContent;activeSuggestion=-1;suggestArea.hidden=!dropdown || !query;input.setAttribute('aria-expanded',String(!suggestArea.hidden));input.removeAttribute('aria-activedescendant');showStates();
    }
    function emptyMessage(t,readingPending,mainAI) {
      if(baseState==='loading') return t.loading;
      if(baseState==='failed') return t.baseFailed;
      if(matched.total || mainAI) return '';
      if(readingPending) return t.loading;
      if(rankState==='loading') return '';
      return readingState==='failed'?t.textNone(committed):t.none(committed);
    }
    function announceResults(t,relatedCount) {
      if(committed && baseState==='ready') {
        const token=JSON.stringify([confirmation,conditionRevision,readingState,matched.total]);
        if(token!==announcedLocal) {
          const readingArrived=announcedLocal && JSON.parse(announcedLocal)[2]!==readingState && readingState==='ready';
          announcedLocal=token;dataStatus.textContent=readingArrived?t.updated(matched.total):t.heading(committed,matched.total);
        }
      }
      const token=JSON.stringify([conditionRevision,rankState,relatedCount]);
      if(token===announcedRank) return;
      announcedRank=token;
      rankStatus.textContent=rankState==='results' && relatedCount?t.found(relatedCount):({
        failed:t.failed,disabled:t.disabled,rate_limited:t.limited,index_updating:t.updating
      })[rankState] || '';
    }
    function renderResults() {
      const t=words[locale],readingPending=!['ready','failed'].includes(readingState),related=rankRows.filter(r=>!dedupeIds.has(r.id));
      const mainAI=baseState==='ready' && !readingPending && matched.total===0 && related.length>0;
      const heading=matched.total===0 && rankState==='loading' && !readingPending?t.heading(committed,null):t.heading(committed,matched.total);
      localHeading.textContent=mainAI?t.related(committed):heading+(baseState==='ready'?(readingPending?' '+t.preparing:readingState==='failed'?' '+t.readingFailed:''):'');
      const retryable=!!committed && baseState==='ready' && !client.disabled && rankState==='stale',compactVisible=!mainAI && related.length>0 && rankState==='results';
      semantic.hidden=client.disabled || !(rankState==='loading' || compactVisible || retryable);semantic.classList.toggle('is-loading',rankState==='loading');semantic.classList.toggle('is-expanded',expandedAI);
      semanticHeading.textContent=rankState==='loading'?t.ranking:t.semantic;semanticHeading.hidden=retryable;retryArea.hidden=!retryable;rankList.hidden=retryable;showAll.hidden=!compactVisible || related.length<=3 || expandedAI;
      fillList(rankList,compactVisible?related.slice(0,expandedAI?related.length:3):[],true);
      fillList(localList,mainAI?related:matched.rows.slice(0,limit));localList.dataset.stSearchList=mainAI?'semantic':'local';
      resultMessage.textContent=emptyMessage(t,readingPending,mainAI);
      resultMessage.hidden=!resultMessage.textContent;more.hidden=mainAI || matched.total<=limit;more.textContent=t.more(Math.max(0,matched.total-limit));
      announceResults(t,related.length);
      showStates();
    }
    function refreshLocal(resetDedupe=true) {if(destroyed) return;lookupSort=selectedSort;matched=committed && engine && Array.from(keyOf(committed)).length<=200?promote(engine.search(committed,activeFilters()),committed):{rows:[],total:0};if(resetDedupe) dedupeIds=new Set(matched.rows.slice(0,20).map(r=>r.id));renderResults();}
    function clearRank(next) {client.invalidate();rankRows=[];rankComplete=false;expandedAI=false;rankState=client.disabled && next!=='handoff'?'disabled':next;}
    function changeFilter() {conditionRevision++;limit=20;if(pending) pending.allowed=false;clearRank(committed?'stale':'idle');refreshLocal();refreshSuggestions();notify();}
    function closeResults() {committed='';pending=null;conditionRevision++;clearRank('idle');selectedSort=previousSort;updateSort();closeDropdown();refreshLocal();notify();call('onResults',{query:'',open:false});}
    function commit(value,allowed) {
      const query=value.trim();if(!query) {closeResults();return;}if(Array.from(query).length>200) return;
      const changed=committed!==query,wasEmpty=!committed;committed=query;
      if(wasEmpty) {previousSort=selectedSort;selectedSort=sorts.find(s=>s.value==='relevance')?.value || selectedSort;updateSort();}
      confirmation++;limit=20;if(changed) {conditionRevision++;clearRank(allowed?'idle':'stale');localList.replaceChildren();}
      closeDropdown();refreshLocal();notify();call('onResults',{query:committed,open:true});
      if(baseState==='loading') {if(changed || allowed || !pending) pending={allowed,revision:conditionRevision};}else if(allowed && baseState==='ready') runRank();
      if(w.matchMedia('(pointer: coarse)').matches) input.blur();const rect=localHeading.getBoundingClientRect();if(rect.top<0 || rect.bottom>w.innerHeight) localHeading.scrollIntoView({block:'start',behavior:'smooth'});
    }
    async function finishTask(task,ticket) {
      let deadline=performance.now()+4;
      for(;;) {
        if(destroyed || ticket!==loadingRevision) {task.return();throw new Error('search_cancelled');}
        const step=task.next();if(step.done) return step.value;
        if(performance.now()>=deadline) {
          await w.STJapaneseSearch.yieldControl();deadline=performance.now()+4;
        }
      }
    }
    async function prepareBase(next,ticket) {
      if (!next || !Array.isArray(next.records) || next.records.length>10000 || !hash.test(next.sourceHash || '') || typeof next.generation!=='string') throw new Error('search_base');
      if(!(['nitori','retail'].includes(adapter.scope)?/^[a-f0-9]{1,32}$/:hash).test(next.generation)) throw new Error('search_base');
      if(next.filterOptions && (typeof next.filterOptions!=='object' || Array.isArray(next.filterOptions)
        || Object.entries(next.filterOptions).some(([key,values])=>!controls.has(key) || !Array.isArray(values) || new Set(values).size!==values.length
          || values.some(value=>typeof value!=='string' || !value || Array.from(value).length>100)))) throw new Error('search_filters');
      const nextLinks=new Map(), nextRecords=new Map(), hrefs=new Set();
      let checked=0;
      for (const r of next.records) {
        const href=safeHref(adapter.href(r),adapter.scope);
        if (hrefs.has(href) || typeof r[adapter.titleField || 'title']!=='string' || !r[adapter.titleField || 'title'].trim()) throw new Error('search_base');
        nextLinks.set(r.id,href);nextRecords.set(r.id,r);hrefs.add(href);
        if((++checked & 31)===0) {
          await w.STJapaneseSearch.yieldControl();
          if(destroyed || ticket!==loadingRevision) throw new Error('search_cancelled');
        }
      }
      const nextParts=next.parts || [{recordIds:next.records.map(r=>r.id),sourceHash:next.sourceHash}];
      if (!Array.isArray(nextParts) || !nextParts.length || nextParts.some(p=>!hash.test(p.sourceHash || '') || !Array.isArray(p.recordIds))) throw new Error('search_base');
      const partIds=nextParts.flatMap(p=>p.recordIds);
      if(partIds.length!==next.records.length || partIds.some((id,i)=>id!==next.records[i].id)) throw new Error('search_base');
      const compare=(a,b)=>adapter.sorts?.find(s=>s.value===lookupSort)?.compare?.(a,b) || adapter.compare?.(a,b) || 0;
      const nextEngine=await finishTask(w.STJapaneseSearch.prepareTask(next.records,adapter.fields,{...adapter.legacy,compare,
        orderKey:()=>lookupSort,sortByRelevance:()=>!lookupSort || lookupSort==='relevance'}),ticket);
      return {next,nextLinks,nextRecords,nextParts,nextEngine};
    }
    async function loadReadings(ticket,cache) {
      try {
        const loaded=await adapter.loadReadings(base,{cache,signal});
        if(destroyed || ticket!==loadingRevision) return;
        const sets=Array.isArray(loaded)?loaded:[{payload:loaded,sourceHash:parts[0].sourceHash,recordIds:parts[0].recordIds}];
        if(sets.length!==parts.length || sets.some((s,i)=>s.sourceHash!==parts[i].sourceHash
          || JSON.stringify(s.recordIds)!==JSON.stringify(parts[i].recordIds))) throw new Error('reading_version');
        await finishTask(engine.attachReadingSetsTask(sets),ticket);
        if(destroyed || ticket!==loadingRevision) return;
        readingState='ready';refreshLocal();refreshSuggestions();
      } catch(error) {
        if(destroyed || ticket!==loadingRevision) return;
        engine?.detachReadings();readingState='failed';refreshLocal();refreshSuggestions();
        if(error.message==='reading_version' && !recoveryAttempted) recover();
      }
    }
    function adopt(prepared) {
      dataRevision++;base=prepared.next;links=prepared.nextLinks;records=prepared.nextRecords;parts=prepared.nextParts;engine=prepared.nextEngine;
      baseState='ready';readingState='preparing';limit=20;
      for(const [key,select] of controls) {
        const values=base.filterOptions?.[key];if(!values) continue;
        const previous=select.value;select.replaceChildren();
        for(const value of ['',...values]) {const option=node('option','',select);option.value=value;if(value) option.textContent=value;else labelText('allOption',option);}
        select.value=values.includes(previous)?previous:'';filters[key]=select.value;
        const chips=chipAreas.get(key);
        if(chips) {chips.replaceChildren();for(const value of ['',...values]) {
          const b=button(null,chips);b.className=adapter.classes?.chip || 'st-search-chip';if(value) b.textContent=value;else labelText('allOption',b);b.dataset.value=value;b.dataset.category=value.toLowerCase();
          b.addEventListener('click',()=>{select.value=value;filters[key]=value;changeFilter();},{signal});
        }}
      }
      clearRank(committed?'stale':'idle');localList.replaceChildren();suggestions.replaceChildren();
      call('onData',base.records);refreshLocal();refreshSuggestions();notify();
      const held=pending;pending=null;
      if(held?.allowed && held.revision===conditionRevision && committed) runRank();
    }
    async function loadBase(cache) {
      const ticket=++loadingRevision;
      try {
        const next=await adapter.loadBase({cache,signal,locale});
        if(destroyed || ticket!==loadingRevision) return;
        const prepared=await prepareBase(next,ticket);
        if(destroyed || ticket!==loadingRevision) return;
        adopt(prepared);await loadReadings(ticket,cache);
      } catch(error) {
        if(destroyed || ticket!==loadingRevision) return;
        if(!engine) baseState='failed';readingState='failed';refreshLocal();refreshSuggestions();
        if(error.message==='reading_version' && !recoveryAttempted) recover();
      }
    }
    function recover() {
      if(recoveryPromise || recoveryAttempted || destroyed) return recoveryPromise;
      // awaitより先に回数とPromiseを確定し、同時検知や入力で枠を戻さない。
      recoveryAttempted=true;engine?.detachReadings();readingState='preparing';pending=null;clearRank('index_updating');refreshLocal();refreshSuggestions();
      recoveryPromise=Promise.resolve().then(()=>loadBase('no-cache')).finally(()=>{recoveryPromise=null;});
      return recoveryPromise;
    }

    async function runRank() {
      if(destroyed || !committed || !base || client.disabled || ['loading','results','no_results'].includes(rankState)) return;
      const condition=rankCondition(),key=JSON.stringify(condition),mine=conditionRevision,revision=dataRevision;
      rankState='loading';rankRows=[];expandedAI=false;renderResults();track('rank_run',{keyword_state:engine?'known':'failed',keyword_count:Math.min(matched.total,6)});
      let result;try {result=await client.run(condition);}catch(_) {if(mine===conditionRevision && revision===dataRevision) {rankState='failed';renderResults();}return;}
      if(!result || destroyed || mine!==conditionRevision || revision!==dataRevision || key!==JSON.stringify(rankCondition())) return;
      if(result.reason==='index_updating' || (result.searched && result.searched.generation!==base.generation)) {clearRank('index_updating');renderResults();recover();return;}
      const linkIds=new Map([...links].map(([rid,href])=>[href,rid]));if(result.rows.some(row=>!linkIds.has(row.href) || (row.id!==row.href && links.get(row.id)!==row.href))) {clearRank('failed');renderResults();return;}
      rankRows=result.rows.map(row=>({...row,id:linkIds.get(row.href)}));rankComplete=result.complete;rankState=result.reason==='disabled'?'disabled':result.reason==='rate_limited'?'rate_limited':result.status;
      renderResults();updateLabels();track('rank_result',{status:result.status,count:rankRows.length,complete:result.complete});
    }
    function run() {if(destroyed || composing || imeEnterHeld || form._stComposing || form._stImeEnterHeld) return;if(adapter.onSubmit) {closeDropdown();call('onSubmit',{query:input.value.trim(),explicit:true});return;}commit(input.value,true);call('onNavigate');}
    form.addEventListener('submit',e=>{e.preventDefault();run();},{signal});
    input.addEventListener('input',()=>{dropdown=inside(document.activeElement);refreshSuggestions();},{signal});
    input.addEventListener('focus',()=>{dropdown=true;refreshSuggestions();if(!external && w.matchMedia('(max-width: 720px)').matches) component.scrollIntoView({block:'start'});},{signal});
    // 借りた欄では、欄（form）と直後の候補の枠を合わせて「欄の部品」とみなす。
    for(const root of external?[form,component]:[component]) {
      root.addEventListener('focusin',()=>focusRoot.classList.add('is-focused'),{signal});
      root.addEventListener('focusout',e=>{if(!inside(e.relatedTarget)) {focusRoot.classList.remove('is-focused');closeDropdown();}},{signal});
    }
    document.addEventListener('pointerdown',e=>{if(!inside(e.target)) closeDropdown();},{signal});
    suggestions.addEventListener('pointerdown',e=>{if(e.target.closest('[role="option"]')) e.preventDefault();},{signal});
    suggestions.addEventListener('click',e=>{if(e.target.closest('.st-search-submit-option')) run();else if(e.target.closest('a')) closeDropdown();},{signal});
    input.addEventListener('compositionstart',()=>{composing=true;showStates();},{signal});input.addEventListener('compositionend',()=>{composing=false;refreshSuggestions();},{signal});
    const enter=e=>e.key==='Enter' || e.code==='Enter' || e.code==='NumpadEnter';
    form.addEventListener('keydown',e=>{if(!enter(e)) return;if(composing || e.isComposing || e.keyCode===229) {imeEnterHeld=true;return;}if(imeEnterHeld || e.repeat) e.preventDefault();},{capture:true,signal});
    document.addEventListener('keyup',e=>{if(enter(e)) imeEnterHeld=false;},{signal});w.addEventListener('blur',()=>{imeEnterHeld=false;},{signal});
    input.addEventListener('keydown',e=>{
      if(composing || e.isComposing || e.keyCode===229 || imeEnterHeld || e.repeat) return;
      if(e.key==='Escape') {e.preventDefault();if(!suggestArea.hidden) closeDropdown();else {input.value='';refreshSuggestions();}return;}
      if(['ArrowDown','ArrowUp'].includes(e.key) && input.value.trim()) {
        e.preventDefault();if(suggestArea.hidden) {dropdown=true;refreshSuggestions();}const count=suggestions.children.length,step=e.key==='ArrowDown'?1:-1;
        activeSuggestion=activeSuggestion<0?(step>0?0:count-1):(activeSuggestion+step+count)%count;[...suggestions.children].forEach((n,i)=>n.setAttribute('aria-selected',String(i===activeSuggestion)));
        input.setAttribute('aria-activedescendant',suggestions.children[activeSuggestion].id);call('onNavigate');
      }
      if(e.key==='Enter' && activeSuggestion>=0 && !suggestArea.hidden) {e.preventDefault();const option=suggestions.children[activeSuggestion];(option.querySelector('a') || option).click();}
    },{signal});
    clear.addEventListener('click',()=>{input.value='';closeResults();input.focus();refreshSuggestions();},{signal});
    more.addEventListener('click',()=>{limit+=20;renderResults();},{signal});showAll.addEventListener('click',()=>{expandedAI=true;renderResults();},{signal});retry.addEventListener('click',()=>{if(!composing) runRank();},{signal});
    function recordClick(event) {
      const a=event.target.closest?.('a.st-search-link');
      if(!a || (event.type==='auxclick' && event.button!==1)) return;
      const list=a.closest('[data-st-search-list]'), kind=list?.dataset.stSearchList || '';
      const query=keyOf(kind==='suggest'?input.value:committed);
      if(!kind || !query || Array.from(query).length>200) return;
      const body={scope:adapter.scope,query,href:a.getAttribute('href'),list:kind,position:[...list.children].indexOf(a.closest('.st-search-result'))+(kind==='suggest'?0:1)};
      try {
        if(localStorage.getItem('st-analytics')==='off') return;
        const day=new Date().toISOString().slice(0,10), key=JSON.stringify([body.scope,query,body.href]);
        let seen=null;
        try {seen=JSON.parse(localStorage.getItem('st-search-clicks') || 'null');} catch(_) {}
        if(!seen || seen.day!==day || !Array.isArray(seen.keys)) seen={day,keys:[]};
        if(seen.keys.includes(key)) return;
        localStorage.setItem('st-search-clicks',JSON.stringify({day,keys:[...seen.keys,key].slice(-300)}));
      } catch(_) {}
      try {
        const blob=new Blob([JSON.stringify(body)],{type:'application/json'});
        if(!navigator.sendBeacon?.('/search/api/click',blob)) fetch('/search/api/click',{method:'POST',body:blob,keepalive:true,credentials:'omit'}).catch(()=>{});
      } catch(_) {}
    }
    results.addEventListener('click',recordClick,{signal});
    results.addEventListener('auxclick',recordClick,{signal});
    component.addEventListener('click',recordClick,{signal});
    component.addEventListener('auxclick',recordClick,{signal});

    updateLabels();updateSort();refreshLocal();
    // 欄は動かしていないので、読み込み中に始めた入力（IME の変換中を含む）はそのまま続く。
    dropdown=inside(document.activeElement);focusRoot.classList.toggle('is-focused',dropdown);refreshSuggestions();const ready=loadBase('default');
    return {ready,run,cancel:()=>{conditionRevision++;clearRank('stale');renderResults();},handoff:()=>{conditionRevision++;pending=null;clearRank('handoff');renderResults();},
      // 受け渡しは①だけで確定する。explicit は呼び出し側が明示操作と確かめた場合だけ（日刊の号からの確定）。
      setQuery(value,options={}) {input.value=String(value).slice(0,400);commit(input.value,options.explicit===true);refreshSuggestions();},
      setLocale(value) {if(!['ja','en'].includes(value) || value===locale) return;locale=value;conditionRevision++;if(pending) pending.allowed=false;clearRank(committed?'stale':'idle');
        updateLabels();updateSort();localList.replaceChildren();rankList.replaceChildren();refreshLocal();refreshSuggestions();notify();},
      openPrivacy,focus:()=>input.focus(),get state(){return {base:baseState,readings:readingState,rank:rankState,total:matched.total,query:committed,recoveryAttempted,dataRevision};},
      destroy(){destroyed=true;loadingRevision++;controller.abort();client.cancel();delete form.dataset.stSearchOwned;delete container.dataset.stSearchMounted;if(external) {component.remove();form.classList.remove('is-focused');}container.replaceChildren();}}
  }
  w.STSearchUI={mount};
})(window);
