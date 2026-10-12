/** Phase 4共通UI。ページ側はデータ・フィールド・filters・同点順・リンクだけを宣言する。 */
(function (w) {
  'use strict';
  const words = {
    ja: {input:'検索語',submit:'検索',all:'全候補を見る',more:'さらに100件表示',cancel:'検索を中止',
      local:'① 文字・読みの一致',semantic:'② 意味の近い候補',suggestions:'入力中の候補',
      ready:'文字と読みで検索できます。',preparing:'文字で検索できます。読みを準備しています。',
      readingFailed:'文字で検索できます。読みは利用できません。',loading:'検索対象を読み込んでいます。',
      baseFailed:'検索対象を取得できませんでした。ページを再読み込みすると取得し直します。',
      ranking:'意味の近い候補を調べています。',failed:'意味検索を利用できません。文字・読みの一致を確認してください。',
      stale:'条件が変わりました。検索すると意味の近い候補も調べます。',limited:'意味検索の利用上限に達しました。',
      updating:'検索データを更新しています。意味検索は次の検索操作で実行します。',
      disabled:'意味検索は停止中です。',none:'選んだ候補に意味の近い結果はありませんでした。',sort:'並べ替え',
      allOption:'すべて',count:n=>`${n}件一致`,shown:(n,total)=>`${n}件表示／${total}件`,coverage:(n,c,total,complete)=>`${total}件から${c}件を選択、${n}件を判定${complete?'':'（判定未完了）'}`,
      privacy:'検索ボタン／Enterで、検索語と公開済みの候補情報をTypeSafe AIへ送ります。入力中・絞り込み・追加表示では送信しません。ファイルやツールの処理内容は送りません。',
      privacyTitle:'検索とプライバシー',privacyDetails:'TypeSafe AI（Jev）の入力はモデルの学習に使われません。保持期間は明示されていません。米国のサーバーで処理されます。利用回数の制限のためIPアドレスを記録します。検索語・応答はサイトのDB・運用ログ・運用通知には残しません。',privacyLink:'TypeSafe AIのプライバシーポリシー'},
    en: {input:'Search query',submit:'Search',all:'View all matches',more:'Show 100 more',cancel:'Cancel search',
      local:'① Text and reading matches',semantic:'② Related results',suggestions:'Suggestions',
      ready:'Text and reading search is ready.',preparing:'Text search is ready. Preparing readings.',
      readingFailed:'Text search is ready. Readings are unavailable.',loading:'Loading search data.',
      baseFailed:'Search data could not be loaded. Reload the page to fetch it again.',
      ranking:'Finding related results.',failed:'Related search is unavailable. Check text and reading matches.',
      stale:'Conditions changed. Search again to find related results.',limited:'Related search has reached its usage limit.',
      updating:'Search data is updating. Related search will run on your next Search action.',
      disabled:'Related search is disabled.',none:'No related results among the selected candidates.',sort:'Sort',
      allOption:'All',count:n=>`${n} matches`,shown:(n,total)=>`Showing ${n} of ${total}`,coverage:(n,c,total,complete)=>`Selected ${c} of ${total}, judged ${n}${complete?'':' (incomplete)'}`,
      privacy:'Search / Enter sends your query and public candidate information to TypeSafe AI. Typing, filters and additional pages do not send it. Files and tool processing contents are not sent.',
      privacyTitle:'Search and privacy',privacyDetails:'TypeSafe AI (Jev) inputs are not used for model training. The retention period is not specified. Processing takes place on servers in the United States. Your IP is recorded to limit usage. Queries and replies are not stored in the site database, operational logs or notifications.',privacyLink:'TypeSafe AI privacy policy'}
  };
  let serial = 0;
  const hash = /^[a-f0-9]{64}$/;
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
  function mount(container, adapter) {
    if (!container || !adapter || typeof adapter.loadBase !== 'function' || typeof adapter.loadReadings !== 'function'
      || typeof adapter.href !== 'function' || !['site','tools','game','nitori','retail'].includes(adapter.scope)) throw new Error('search_adapter');
    if (container.dataset.stSearchMounted) throw new Error('search_mounted');
    container.dataset.stSearchMounted = '1'; container.classList.add('st-search');
    const id = `st-search-${++serial}`, client = w.STSiteSearch.createRankClient({scope:adapter.scope});
    const controller = new AbortController(), signal = controller.signal;
    let locale = adapter.locale === 'en' ? 'en' : 'ja', engine = null, base = null, links = new Map(), parts = null;
    let dataRevision = 0, loadingRevision = 0, conditionRevision = 0, destroyed = false, composing = false, imeEnterHeld = false;
    let readingState = 'unfetched', baseState = 'loading', rankState = 'idle', rankRows = [], rankInfo = null, rankComplete = false;
    let recoveryAttempted = false, recoveryPromise = null, hasRun = false, submitted = false, openAll = false, limit = 100, activeSuggestion = -1;
    let matched = {rows:[],total:0}, selectedSort = adapter.sorts?.[0]?.value || '';
    const filters = {}, controls = new Map(), labelled = [];
    const node = (tag, className, parent) => {const n = document.createElement(tag); if (className) n.className=className; if (parent) parent.append(n); return n;};
    const labelValue = key => typeof key==='string'?words[locale][key]:(locale==='en' && key.label_en || key.label);
    const labelText = (key, n) => {labelled.push([key,n]); n.textContent=labelValue(key);};
    const button = (key, parent) => {const n=node('button','st-search-button',parent);n.type='button';labelText(key,n);return n;};
    const form=node('form','st-search-form',container), label=node('label','st-search-label',form);
    label.htmlFor=id+'-input';labelText('input',label);
    const box=node('div','st-search-input-row',form), input=node('input','st-search-input',box);
    input.type='search';input.id=id+'-input';input.maxLength=400;input.autocomplete='off';input.spellcheck=false;
    input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
    const submit=button('submit',box);submit.type='submit';
    const filterArea=node('div','st-search-filters',form);
    for (const spec of adapter.filters || []) {
      const allowed={site:[],tools:['category'],game:['genre'],nitori:['category','region','month'],retail:['category','region','month']};
      if (!spec || !allowed[adapter.scope].includes(spec.key) || !Array.isArray(spec.options) || controls.has(spec.key)) throw new Error('search_filters');
      const l=node('label','',filterArea), text=node('span','',l), select=node('select','',l);
      labelText(spec,text);select.dataset.filter=spec.key;
      for (const choice of spec.options) {const option=node('option','',select);option.value=choice.value;labelText(choice,option);}
      filters[spec.key]=select.value;controls.set(spec.key,select);
      select.addEventListener('change',()=>{filters[spec.key]=select.value;changeCondition();},{signal});
    }
    if (adapter.sorts?.length) {
      const l=node('label','',filterArea), text=node('span','',l), select=node('select','',l);labelText('sort',text);
      select.dataset.sort='1';for (const choice of adapter.sorts) {const option=node('option','',select);option.value=choice.value;labelText(choice,option);}
      select.addEventListener('change',()=>{selectedSort=select.value;changeCondition();},{signal});
    }
    const dataStatus=node('p','st-search-data-status',container);dataStatus.setAttribute('role','status');
    const suggestArea=node('div','st-search-suggestions',container), suggestLabel=node('span','st-search-label',suggestArea);
    labelText('suggestions',suggestLabel);suggestLabel.id=id+'-suggest-label';
    const suggestions=node('ul','st-search-list',suggestArea);suggestions.id=id+'-suggestions';suggestions.setAttribute('role','listbox');
    suggestions.setAttribute('aria-labelledby',suggestLabel.id);input.setAttribute('aria-controls',suggestions.id);input.setAttribute('aria-expanded','false');
    const suggestionCount=node('p','st-search-count',suggestArea), all=button('all',suggestArea);
    const local=node('section','st-search-local',container), localHeading=node('h3','st-search-heading',local);labelText('local',localHeading);
    const localCount=node('p','st-search-count',local), localList=node('ul','st-search-list',local), more=button('more',local);
    const semantic=node('section','st-search-semantic',container), semanticHeading=node('h3','st-search-heading',semantic);labelText('semantic',semanticHeading);
    const rankStatus=node('p','st-search-rank-status',semantic);rankStatus.setAttribute('role','status');
    const rankList=node('ul','st-search-list',semantic), coverage=node('p','st-search-coverage',semantic), cancel=button('cancel',semantic);
    const privacy=node('p','st-search-privacy',container);labelText('privacy',privacy);
    const disclosure=node('details','st-search-privacy-details',container);labelText('privacyTitle',node('summary','',disclosure));
    labelText('privacyDetails',node('p','',disclosure));const policy=node('a','',disclosure);policy.href='https://typesafe.ai/legal/privacy-policy';labelText('privacyLink',policy);
    const track=(event,values)=>{if(typeof adapter.track==='function'){try{adapter.track(event,values);}catch(_){}}};
    const call=(name,value)=>{try{adapter[name]?.(value);}catch(_){}};
    const notify=()=>call('onConditions',{...rankCondition(),sort:selectedSort});
    const activeFilters=()=>Object.fromEntries(Object.entries(filters).filter(([,v])=>v));
    function rankCondition() {
      return {query:input.value.trim(),locale,filters:activeFilters(),generation:base?.generation};
    }
    function displayed(row) {
      if(!row.record) return row;
      const record=row.record;
      const display=adapter.displayFields?.[locale] || {};
      return {id:row.id || record.id,href:row.href || links.get(record.id),title:record[display.title] || record[adapter.titleField || 'title'],
        description:record[display.description] || record[adapter.descriptionField || 'description'] || ''};
    }
    function addRow(list,row,suggestion,index) {
      const r=displayed(row), li=node('li','st-search-result',list), a=node('a','st-search-link',li);
      if (suggestion) {li.setAttribute('role','option');li.id=id+'-option-'+index;}
      a.href=safeHref(r.href,adapter.scope);li.dataset.id=r.id;
      node('span','st-search-title',a).textContent=r.title;
      // 入力中は選択に使う題名を6件。説明は全候補と①②の結果で読む。
      if(r.description && !suggestion) node('span','st-search-description',a).textContent=r.description;
      return li;
    }
    // 追加表示では既存行を残す。重複除去後の集合から100件ずつ補う。
    function fillList(list,rows,suggestion=false) {
      const old=[...list.children];let shared=0;
      while(shared<old.length && shared<rows.length && old[shared].dataset.id===rows[shared].id) shared++;
      for (let i=old.length-1;i>=shared;i--) old[i].remove();
      for (let i=shared;i<rows.length;i++) addRow(list,rows[i],suggestion,i);
    }
    function showStates() {
      const t=words[locale];
      // role=statusの同じ文を入力のたびに差し替えて、読み上げを繰り返さない。
      const dataText=baseState==='loading'?t.loading:baseState==='failed'?t.baseFailed:
        readingState==='ready'?t.ready:readingState==='failed'?t.readingFailed:t.preparing;
      const rankText=rankState==='loading'?t.ranking:rankState==='stale'?t.stale:rankState==='index_updating'?t.updating:
        rankState==='failed'?t.failed:rankState==='rate_limited'?t.limited:rankState==='disabled'?t.disabled:rankState==='no_results'?t.none:'';
      if(dataStatus.textContent!==dataText) dataStatus.textContent=dataText;
      if(rankStatus.textContent!==rankText) rankStatus.textContent=rankText;
      cancel.hidden=rankState!=='loading';submit.disabled=composing || rankState==='loading';
      semantic.hidden=!input.value.trim() || ['idle','handoff'].includes(rankState);
      all.disabled=composing;more.disabled=composing;
      coverage.textContent=rankInfo?t.coverage(rankInfo.judged,rankInfo.candidates,rankInfo.total,rankComplete):'';
      call('onState',{base:baseState,readings:readingState,rank:rankState,total:matched.total,query:input.value.trim(),composing,submitted,complete:rankComplete});
    }
    function refreshLocal() {
      if (destroyed) return;
      // 長すぎる入力は送信・照合せず、入力欄自体の内容は書き換えない。
      matched=engine && Array.from(w.STJapaneseSearch.normalize(input.value).trim()).length<=200?engine.search(input.value,activeFilters()):{rows:[],total:0};
      const occupied=new Set(rankRows.map(r=>r.href)), visible=rankRows.length?matched.rows.filter(r=>!occupied.has(links.get(r.id))):matched.rows;
      suggestArea.hidden=!input.value.trim() || !engine || openAll;
      input.setAttribute('aria-expanded',String(!suggestArea.hidden && visible.length>0));
      activeSuggestion=-1;input.removeAttribute('aria-activedescendant');
      fillList(suggestions,visible.slice(0,6),true);suggestionCount.textContent=words[locale].count(matched.total);
      local.hidden=!openAll || !input.value.trim();fillList(localList,openAll?visible.slice(0,limit):[]);
      localCount.textContent=words[locale].count(matched.total)+' · '+words[locale].shown(Math.min(limit,visible.length),visible.length);
      more.hidden=visible.length<=limit;showStates();
    }
    function clearRank(next) {
      client.invalidate();rankRows=[];rankInfo=null;rankList.replaceChildren();rankState=client.disabled && next!=='handoff'?'disabled':next;showStates();
    }
    function changeCondition() {
      conditionRevision++;submitted=false;limit=100;clearRank(hasRun && input.value.trim()?'stale':'idle');refreshLocal();
      call('onQueryChange',input.value.trim());notify();
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
      const nextLinks=new Map(), hrefs=new Set();
      let checked=0;
      for (const r of next.records) {
        const href=safeHref(adapter.href(r),adapter.scope);
        if (hrefs.has(href) || typeof r[adapter.titleField || 'title']!=='string' || !r[adapter.titleField || 'title'].trim()) throw new Error('search_base');
        nextLinks.set(r.id,href);hrefs.add(href);
        if((++checked & 31)===0) {
          await w.STJapaneseSearch.yieldControl();
          if(destroyed || ticket!==loadingRevision) throw new Error('search_cancelled');
        }
      }
      const nextParts=next.parts || [{recordIds:next.records.map(r=>r.id),sourceHash:next.sourceHash}];
      if (!Array.isArray(nextParts) || !nextParts.length || nextParts.some(p=>!hash.test(p.sourceHash || '') || !Array.isArray(p.recordIds))) throw new Error('search_base');
      const partIds=nextParts.flatMap(p=>p.recordIds);
      if(partIds.length!==next.records.length || partIds.some((id,i)=>id!==next.records[i].id)) throw new Error('search_base');
      const compare=(a,b)=>adapter.sorts?.find(s=>s.value===selectedSort)?.compare?.(a,b) || adapter.compare?.(a,b) || 0;
      const nextEngine=await finishTask(w.STJapaneseSearch.prepareTask(next.records,adapter.fields,{...adapter.legacy,compare,
        orderKey:()=>selectedSort,sortByRelevance:()=>!selectedSort || selectedSort==='relevance'}),ticket);
      return {next,nextLinks,nextParts,nextEngine};
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
        readingState='ready';refreshLocal();
      } catch(error) {
        if(destroyed || ticket!==loadingRevision) return;
        engine?.detachReadings();readingState='failed';refreshLocal();
        if(error.message==='reading_version' && !recoveryAttempted) recover();
      }
    }
    function adopt(prepared) {
      dataRevision++;base=prepared.next;links=prepared.nextLinks;parts=prepared.nextParts;engine=prepared.nextEngine;
      baseState='ready';readingState='preparing';limit=100;
      for(const [key,select] of controls) {
        const values=base.filterOptions?.[key];if(!values) continue;
        const previous=select.value;select.replaceChildren();
        for(const value of ['',...values]) {const option=node('option','',select);option.value=value;if(value) option.textContent=value;else labelText('allOption',option);}
        select.value=values.includes(previous)?previous:'';filters[key]=select.value;
      }
      clearRank(hasRun?'stale':'idle');localList.replaceChildren();suggestions.replaceChildren();refreshLocal();
      call('onData',base.records);notify();
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
        if(!engine) baseState='failed';readingState='failed';refreshLocal();
        if(error.message==='reading_version' && !recoveryAttempted) recover();
      }
    }
    function recover() {
      if(recoveryPromise || recoveryAttempted || destroyed) return recoveryPromise;
      // awaitより先に回数とPromiseを確定し、同時検知や入力で枠を戻さない。
      recoveryAttempted=true;engine?.detachReadings();readingState='preparing';clearRank('index_updating');refreshLocal();
      recoveryPromise=Promise.resolve().then(()=>loadBase('no-cache')).finally(()=>{recoveryPromise=null;});
      return recoveryPromise;
    }
    async function run() {
      if(destroyed || composing || imeEnterHeld || !input.value.trim() || Array.from(input.value.trim()).length>200) return;
      openAll=true;
      if(base && client.disabled) {submitted=true;rankState='disabled';}
      refreshLocal();
      if(!base || client.disabled || ['loading','results','no_results'].includes(rankState)) return;
      const condition=rankCondition(), key=JSON.stringify(condition), mine=conditionRevision, revision=dataRevision;
      hasRun=true;submitted=true;rankState='loading';rankRows=[];rankInfo=null;rankList.replaceChildren();refreshLocal();
      track('rank_run',{keyword_state:engine?'known':'failed',keyword_count:Math.min(matched.total,6)});
      let result;
      try {result=await client.run(condition);} catch(_) {rankState='failed';showStates();return;}
      if(!result || destroyed || mine!==conditionRevision || revision!==dataRevision || key!==JSON.stringify(rankCondition())) return;
      if(result.reason==='index_updating' || (result.searched && result.searched.generation!==base.generation)) {
        clearRank('index_updating');recover();return;
      }
      const linkIds=new Map([...links].map(([id,href])=>[href,id]));
      if(result.rows.some(row=>!linkIds.has(row.href) || (row.id!==row.href && links.get(row.id)!==row.href))) {
        clearRank('failed');refreshLocal();return;
      }
      rankRows=result.rows.map(row=>({...row,id:linkIds.get(row.href)}));rankInfo=result.searched;rankComplete=result.complete;
      rankState=result.reason==='disabled'?'disabled':result.reason==='rate_limited'?'rate_limited':result.status;
      fillList(rankList,rankRows);refreshLocal();track('rank_result',{status:result.status,count:rankRows.length,complete:result.complete});
    }
    form.addEventListener('submit',event=>{event.preventDefault();run();},{signal});
    input.addEventListener('input',()=>{openAll=false;changeCondition();},{signal});
    input.addEventListener('compositionstart',()=>{composing=true;changeCondition();},{signal});
    input.addEventListener('compositionend',()=>{composing=false;changeCondition();},{signal});
    const enter=event=>event.key==='Enter' || event.code==='Enter' || event.code==='NumpadEnter';
    form.addEventListener('keydown',event=>{
      if(!enter(event)) return;
      if(composing || event.isComposing || event.keyCode===229) {imeEnterHeld=true;return;}
      if(imeEnterHeld || event.repeat) event.preventDefault();
    },{capture:true,signal});
    document.addEventListener('keyup',event=>{if(enter(event)) imeEnterHeld=false;},{signal});
    w.addEventListener('blur',()=>{imeEnterHeld=false;},{signal});
    input.addEventListener('keydown',event=>{
      if(composing || event.isComposing || event.keyCode===229 || imeEnterHeld || event.repeat) return;
      if(event.key==='Escape') {suggestArea.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');return;}
      if(['ArrowDown','ArrowUp'].includes(event.key) && !suggestArea.hidden && suggestions.children.length) {
        const count=suggestions.children.length, step=event.key==='ArrowDown'?1:-1;
        event.preventDefault();activeSuggestion=activeSuggestion<0?(step>0?0:count-1):(activeSuggestion+step+count)%count;
        [...suggestions.children].forEach((n,i)=>n.setAttribute('aria-selected',String(i===activeSuggestion)));
        input.setAttribute('aria-activedescendant',suggestions.children[activeSuggestion].id);
      }
      if(event.key==='Enter' && activeSuggestion>=0 && !suggestArea.hidden) {
        event.preventDefault();suggestions.children[activeSuggestion]?.querySelector('a')?.click();
      }
    },{signal});
    all.addEventListener('click',()=>{if(!composing){openAll=true;refreshLocal();}},{signal});
    more.addEventListener('click',()=>{if(!composing){limit+=100;refreshLocal();}},{signal});
    const releaseRank=next=>{conditionRevision++;clearRank(next);refreshLocal();};
    const cancelRank=()=>releaseRank('stale');
    cancel.addEventListener('click',cancelRank,{signal});
    showStates();refreshLocal();
    const ready=loadBase('default');
    return {ready,run,cancel:cancelRank,
      // ③への引き継ぎでは確定条件を保ち、②の結果と通知だけを消す。
      handoff:()=>releaseRank('handoff'),
      setQuery(value){input.value=String(value).slice(0,400);openAll=true;changeCondition();},
      setLocale(value){if(!['ja','en'].includes(value) || value===locale) return;locale=value;labelled.forEach(([key,n])=>{n.textContent=labelValue(key);});
        localList.replaceChildren();suggestions.replaceChildren();changeCondition();},
      get state(){return {base:baseState,readings:readingState,rank:rankState,total:matched.total,recoveryAttempted,dataRevision};},
      destroy(){destroyed=true;loadingRevision++;controller.abort();client.cancel();delete container.dataset.stSearchMounted;container.replaceChildren();}};
  }
  w.STSearchUI={mount};
})(window);
