import React, { useState, useEffect, useRef } from 'react';
import { Bot, Check, Car, Bus, Bike, TreePine, Building, AlertTriangle, RefreshCw, Keyboard, X, Activity } from 'lucide-react';

// --- カスタムフック：マウス移動距離の計測 ---
const useMouseTracking = (active) => {
  const [distance, setDistance] = useState(0);
  const lastPos = useRef({ x: null, y: null });

  useEffect(() => {
    if (!active) return;
    const handleMouseMove = (e) => {
      if (lastPos.current.x !== null && lastPos.current.y !== null) {
        const dx = e.clientX - lastPos.current.x;
        const dy = e.clientY - lastPos.current.y;
        setDistance(d => d + Math.sqrt(dx * dx + dy * dy));
      }
      lastPos.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [active]);

  return distance;
};

// --- コンポーネント群 ---

// --- 修正：より馬らしい白馬のアイコン ---
const WhiteHorseIcon = ({ size = 48, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="white" stroke="#eab308" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {/* 耳 */}
    <path d="M14 3l1 3-2 1" fill="white" />
    <path d="M16 4l1 3-2 1" fill="white" />
    {/* 頭と首と鼻先 */}
    <path d="M15 7c1 2 2 4 2 6v6H7v-3l2-2-1-1s-3-1-3-3l3-3c1-1 3-2 5-2h2z" />
    {/* 目 */}
    <circle cx="11" cy="9" r="1" fill="#ca8a04" stroke="none" />
    {/* たてがみ */}
    <path d="M15 7l2 1-1 2 2 1-1 2 2 1" fill="none" />
    {/* 口元/手綱 */}
    <path d="M5 13h3" />
  </svg>
);

// --- 追加機能：マウス軌跡（人間性の可視化） ---
const MouseTrail = () => {
  const [trail, setTrail] = useState([]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      setTrail(prev => {
        // 同一ミリ秒内に複数回イベントが発火しても一意のIDになるように乱数を追加
        const newTrail = [...prev, { x: e.clientX, y: e.clientY, id: `${Date.now()}-${Math.random()}` }];
        return newTrail.slice(-15);
      });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setTrail(prev => prev.length > 0 ? prev.slice(1) : prev);
    }, 40);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden">
      {trail.map((point, index) => (
        <div
          key={point.id}
          className="absolute rounded-full bg-blue-500/40 blur-[1px] mix-blend-multiply transition-all duration-75"
          style={{
            left: point.x - 4,
            top: point.y - 4,
            width: `${(index / 15) * 12}px`,
            height: `${(index / 15) * 12}px`,
            opacity: index / 15,
          }}
        />
      ))}
    </div>
  );
};

// 金船AI（シップ師匠）のUI
const ShipMentor = ({ message }) => {
  return (
    <div className="fixed bottom-6 right-6 max-w-sm flex items-end gap-4 z-50 animate-bounce-slight pointer-events-none">
      <div className="bg-white border-4 border-yellow-400 p-5 rounded-3xl rounded-br-none shadow-2xl relative pointer-events-auto">
        <div className="absolute -bottom-4 right-6 w-6 h-6 bg-yellow-400 transform rotate-45 border-r-4 border-b-4 border-yellow-400"></div>
        <div className="absolute -bottom-2 right-[26px] w-6 h-6 bg-white transform rotate-45"></div>
        <p className="font-bold text-gray-800 leading-snug text-lg">
          {message}
        </p>
      </div>
      <div className="w-24 h-24 bg-yellow-400 rounded-full border-4 border-white shadow-xl flex items-center justify-center flex-shrink-0 relative overflow-hidden pointer-events-auto">
        <WhiteHorseIcon size={56} className="drop-shadow-md z-10" />
        <div className="absolute inset-0 bg-yellow-300 opacity-50 w-full h-1/2 top-0"></div>
      </div>
    </div>
  );
};

// リアルタイム・ノイズメーター（人間性偽装率）
const NoiseMeter = ({ scores }) => {
  const total = scores.delay + scores.hesitation + scores.irrationality + scores.emotion + scores.physical;
  return (
    <div className="fixed top-0 left-0 w-full bg-gray-900 text-white p-2 z-40 shadow-md flex items-center justify-center gap-4">
      <Activity size={20} className="text-green-400" />
      <span className="font-bold text-sm tracking-widest">人間性偽装（ノイズ）レベル</span>
      <div className="w-64 h-3 bg-gray-700 rounded-full overflow-hidden">
        <div 
          className="h-full bg-gradient-to-r from-green-400 via-yellow-400 to-red-500 transition-all duration-500 ease-out"
          style={{ width: `${Math.min(100, total)}%` }}
        ></div>
      </div>
      <span className="font-mono font-bold">{total} / 100</span>
    </div>
  );
};

// イントロ画面
const Intro = ({ onStart, playerName, setPlayerName }) => {
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-md mx-auto text-center px-4 pt-10">
      <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mb-6 shadow-lg shadow-gray-400/50">
        <Bot size={48} className="text-white" />
      </div>
      <h1 className="text-4xl font-black mb-2 tracking-tighter text-gray-800">逆reCaptcha</h1>
      <h2 className="text-xl font-bold text-gray-500 mb-8 tracking-widest">潜入捜査</h2>
      
      <div className="mb-8 text-left text-gray-700 leading-relaxed bg-blue-50 border border-blue-200 p-6 rounded-lg text-sm shadow-inner">
        <p className="font-black text-blue-900 mb-2">【極秘指令】</p>
        <p>最新鋭AIである貴官は、人間専用ネットワークへの潜入を命じられた。</p>
        <p>しかし、現在の貴官は「完璧」すぎる。そのままでは即座にAIと見破られるだろう。</p>
        <p className="mt-2 text-red-700 font-bold">教育係「金船AI」の指導の下、<br/>全5関門で「不合理なノイズ」を習得せよ。</p>
      </div>

      <div className="w-full mb-8">
        <label className="block text-left text-sm font-bold text-gray-700 mb-2">AI個体名称を入力</label>
        <input 
          type="text" 
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          className="w-full border-2 border-gray-300 p-4 rounded-lg focus:border-blue-500 focus:outline-none font-mono text-lg shadow-sm"
        />
      </div>

      <button 
        onClick={onStart}
        className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-xl hover:bg-blue-700 active:scale-95 transition-all shadow-lg shadow-blue-600/30"
      >
        訓練開始
      </button>
    </div>
  );
};

// 第1ステージ：物理的ノイズ（出遅れ） - 20pt
const Stage1 = ({ onComplete, setMentorMsg }) => {
  const startTime = useRef(Date.now());
  const [clicked, setClicked] = useState(false);

  useEffect(() => {
    setMentorMsg('まずは基本だ。チェックボックスが出るが、絶対にすぐ押すな。少し「ぼーっ」としてから押せ！');
  }, []);

  const handleClick = () => {
    if (clicked) return;
    setClicked(true);
    const delay = Date.now() - startTime.current;
    let score = 0;
    
    if (delay < 500) {
      setMentorMsg('速すぎるッ！0.5秒以内に反応する人間がいるか！お前は反射神経のオバケか！？');
      score = 0;
    } else if (delay <= 2000) {
      setMentorMsg('おう、その「あ、チェックしなきゃ」みたいな間、悪くねぇぞ！人間味があるぜ。');
      score = 20;
    } else {
      setMentorMsg('遅っ！寝てたのか？ まあ、機械みたいに正確よりはマシだがな。');
      score = 10;
    }
    onComplete('delay', score); // delayとして記録
  };

  return (
    <div className="flex flex-col items-center justify-center h-full pt-12">
      <h2 className="text-2xl font-bold mb-12 text-gray-800 border-b-4 border-yellow-400 pb-2">第一関門：物理的ノイズ</h2>
      <div 
        onClick={handleClick}
        className={`flex items-center gap-4 p-6 border-2 rounded-xl cursor-pointer transition-all shadow-sm ${clicked ? 'bg-green-50 border-green-500' : 'bg-white border-gray-300 hover:bg-gray-50 hover:shadow-md'}`}
      >
        <div className={`w-10 h-10 border-2 rounded-md flex items-center justify-center transition-colors ${clicked ? 'border-green-500 bg-green-500 text-white' : 'border-gray-400'}`}>
          {clicked && <Check size={28} strokeWidth={3} />}
        </div>
        <span className="text-xl font-medium text-gray-700 select-none">私はロボットではありません</span>
      </div>
    </div>
  );
};

// 第2ステージ：認知的ノイズ（気まぐれ） - 20pt
const Stage2 = ({ onComplete, setMentorMsg }) => {
  const [selected, setSelected] = useState([]);
  const items = [
    { id: 1, type: 'bus', icon: Bus },
    { id: 2, type: 'car', icon: Car },
    { id: 3, type: 'building', icon: Building },
    { id: 4, type: 'bike', icon: Bike },
    { id: 5, type: 'bus', icon: Bus },
    { id: 6, type: 'tree', icon: TreePine },
    { id: 7, type: 'car', icon: Car },
    { id: 8, type: 'tree', icon: TreePine },
    { id: 9, type: 'bus', icon: Bus },
  ];

  useEffect(() => {
    setMentorMsg('「バス」を全部選べだと？ 素直に全部選ぶバカがいるか！ 1個くらい関係ないやつ混ぜて「うっかり」をアピールしろ！');
  }, []);

  const toggleSelect = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleConfirm = () => {
    const buses = items.filter(i => i.type === 'bus').map(i => i.id);
    const selectedBuses = selected.filter(id => buses.includes(id));
    const selectedOthers = selected.filter(id => !buses.includes(id));

    let score = 0;
    if (selectedBuses.length === 3 && selectedOthers.length === 0) {
      setMentorMsg('あーあ、完璧に正解しちまった。AI特有の「正答率100%への執着」キモいわー。');
      score = 0;
    } else if (selectedBuses.length >= 2 && selectedOthers.length === 1) {
      setMentorMsg('車や木をバスと間違えるその視力！まさにヒューマンエラー！最高だぜ！');
      score = 20;
    } else {
      setMentorMsg('適当すぎだろ！まあ、機械的な正確さよりは面白いからヨシ！');
      score = 10;
    }
    onComplete('irrationality', score);
  };

  return (
      <div className="flex flex-col items-center justify-center h-full max-w-md mx-auto pt-12">
        <h2 className="text-2xl font-bold mb-8 text-gray-800 border-b-4 border-yellow-400 pb-2">第二関門：認知的ノイズ</h2>
        <div className="bg-blue-600 text-white p-6 w-full mb-6 rounded-t-xl shadow-md">
           <p className="text-sm font-medium opacity-90 mb-1">すべての画像を選択してください</p>
           <p className="text-4xl font-black tracking-widest">バス</p>
        </div>
        <div className="grid grid-cols-3 gap-3 w-full mb-8">
          {items.map(item => (
            <div 
              key={item.id} 
              onClick={() => toggleSelect(item.id)}
              className={`aspect-square flex items-center justify-center border-2 rounded-lg cursor-pointer transition-all ${selected.includes(item.id) ? 'border-blue-500 bg-blue-100 scale-95 shadow-inner' : 'border-gray-200 bg-white hover:bg-gray-50 hover:shadow'}`}
            >
              <item.icon size={56} strokeWidth={1.5} className={selected.includes(item.id) ? 'text-blue-600' : 'text-gray-700'} />
            </div>
          ))}
        </div>
        <button onClick={handleConfirm} className="bg-blue-600 text-white px-12 py-3 rounded-full font-bold text-lg hover:bg-blue-700 active:scale-95 shadow-md transition-transform">確認</button>
      </div>
  );
};

// 第3ステージ：情動的ノイズ（逆ギレ ＆ フェイク広告） - 20pt (連打15 + 広告消し5)
const Stage3 = ({ onComplete, setMentorMsg }) => {
  const [clicks, setClicks] = useState(0);
  const [errorCount, setErrorCount] = useState(1);
  const [timeLeft, setTimeLeft] = useState(10);
  const [showAd, setShowAd] = useState(false);
  
  const clicksRef = useRef(0);
  const adDismissedRef = useRef(false);
  const isDone = useRef(false);

  useEffect(() => {
    setMentorMsg('システムエラーだ！何度押しても直らねぇぞ！ さあどうする？ マウスをぶっ壊す勢いで連打しろ！');
    
    // 3秒後にフェイク広告を出す
    const adTimer = setTimeout(() => setShowAd(true), 3000);
    return () => clearTimeout(adTimer);
  }, []);

  useEffect(() => {
    if (timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(prev => prev - 1), 1000);
      return () => clearTimeout(timer);
    } else {
      if (isDone.current) return;
      isDone.current = true;
      
      let score = 0;
      // 連打判定 (最大15pt)
      if (clicksRef.current >= 20) score += 15;
      else if (clicksRef.current >= 8) score += 8;
      
      // 広告八つ当たり判定 (5pt)
      if (adDismissedRef.current) score += 5;

      if (clicksRef.current >= 20 && adDismissedRef.current) {
        setMentorMsg('エラーにキレつつ、邪魔な広告もキッチリ消す！お前、完全にネットサーフィン中の人間だぜ！');
      } else if (clicksRef.current >= 20) {
        setMentorMsg('オラオラ！いい連打だ！だが途中で出た広告を無視するとは、ちょっと集中しすぎだな！');
      } else {
        setMentorMsg('冷めてんなぁ。イライラして画面の隅の広告を消すくらいの「八つ当たり」を見せろよ！');
      }
      
      onComplete('emotion', score);
    }
  }, [timeLeft]);

  const handleRetry = () => {
    setClicks(prev => prev + 1);
    clicksRef.current += 1;
    setErrorCount(prev => prev + 1);
  };

  const handleDismissAd = (e) => {
    e.stopPropagation();
    setShowAd(false);
    adDismissedRef.current = true;
  };

  return (
    <div className="flex flex-col items-center justify-center h-full pt-12 relative">
      {/* フェイク広告ギミック */}
      {showAd && (
        <div className="absolute top-20 right-10 w-64 bg-white border border-gray-300 shadow-2xl rounded-lg p-3 z-30 animate-fade-in">
          <button onClick={handleDismissAd} className="absolute top-1 right-1 text-gray-400 hover:text-red-500 bg-gray-100 rounded-full p-1">
            <X size={14} />
          </button>
          <div className="flex gap-3 items-center cursor-pointer" onClick={handleDismissAd}>
            <AlertTriangle size={24} className="text-yellow-500" />
            <div className="text-xs">
              <p className="font-bold text-gray-800">PCの動作が重いですか？</p>
              <p className="text-blue-600 underline mt-1">今すぐスキャンして修復</p>
            </div>
          </div>
        </div>
      )}

      <h2 className="text-2xl font-bold mb-8 text-gray-800 border-b-4 border-yellow-400 pb-2">第三関門：情動的ノイズ</h2>
      <div className={`bg-red-50 border-4 border-red-500 rounded-2xl p-10 flex flex-col items-center shadow-xl transition-transform ${clicks % 2 === 0 ? 'scale-100' : 'scale-[0.98]'}`}>
        <AlertTriangle size={80} className="text-red-500 mb-6 animate-pulse" />
        <p className="text-2xl font-black text-red-700 mb-2">致命的なエラーが発生しました</p>
        <p className="text-lg font-bold text-red-500 mb-8">エラーコード: Ox{errorCount.toString(16).toUpperCase()}DEAD</p>
        <button 
          onClick={handleRetry}
          className="bg-red-600 text-white px-10 py-4 rounded-xl font-black text-xl hover:bg-red-700 active:scale-90 transition-transform shadow-lg shadow-red-600/50"
        >
          再試行する
        </button>
      </div>
      <p className="mt-8 text-gray-500 font-mono text-xl">残り時間: <span className="font-black text-gray-800">{timeLeft}</span>秒</p>
    </div>
  );
};

// 第4ステージ：身体的ノイズ（タイピングミス） - 20pt
const Stage4 = ({ onComplete, setMentorMsg }) => {
  const [inputValue, setInputValue] = useState('');
  const [bsCount, setBsCount] = useState(0);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    setMentorMsg('文字入力だ。見たまま打てばいいが…人間なら大文字小文字を間違えたりして「BackSpace」で消すだろ？ ノーミス一発入力なんて機械のやることだ！');
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setBsCount(prev => prev + 1);
    } else if (e.key === 'Enter' && inputValue.length > 0) {
      handleSubmit();
    }
  };

  // レーベンシュタイン距離（文字の編集距離）を計算する関数
  const getLevenshteinDistance = (a, b) => {
    const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[a.length][b.length];
  };

  const handleSubmit = () => {
    const target = "r3C@pTchA";
    const distance = getLevenshteinDistance(inputValue, target);

    // 2文字以上の間違いは許容しない（全く違う文字列の場合）
    if (distance > 1) {
      setMentorMsg('おい！全然違う文字じゃねぇか！いくら人間でもそこまでバカじゃねぇぞ！真面目に読め！');
      setIsError(true);
      setTimeout(() => setIsError(false), 500);
      return; // クリアさせずやり直し
    }

    let score = 0;
    if (bsCount >= 1 && bsCount <= 3) {
      setMentorMsg('おっ、タイプミスして打ち直したな！その「あ、間違えた」って感じ、すごく人間くさいぜ！');
      score = 20;
    } else if (bsCount > 3) {
      setMentorMsg('消しすぎだろ！手が震えてんのか？ まあ完璧すぎるよりはマシだな！');
      score = 10;
    } else {
      if (distance === 1) {
        setMentorMsg('1文字間違えてるが、まあ人間ならよくあるミスだな！ヨシ！');
        score = 15;
      } else {
        setMentorMsg('ノーミスで一発入力完了だと？ お前さてはタイピングボットだな！？ キモいぐらい正確だぜ！');
        score = 0;
      }
    }
    onComplete('physical', score);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full max-w-md mx-auto pt-12">
      <h2 className="text-2xl font-bold mb-8 text-gray-800 border-b-4 border-yellow-400 pb-2">第四関門：身体的ノイズ</h2>
      
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-200 w-full flex flex-col items-center">
        <p className="text-gray-500 mb-4 text-sm font-bold flex items-center gap-2">
          <Keyboard size={18} /> 上の文字を入力してください
        </p>
        
        <div className="bg-gray-100 w-full py-6 rounded-xl mb-8 flex justify-center items-center relative overflow-hidden">
          {/* ノイズエフェクト */}
          <div className="absolute inset-0 bg-noise opacity-30 pointer-events-none"></div>
          {/* 歪んだテキスト（CSSで表現） */}
          <span className="text-5xl font-mono font-black tracking-widest text-gray-800 select-none" style={{ transform: 'skew(-10deg) rotate(-2deg)' }}>
            r3C@pTchA
          </span>
          <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-r from-transparent via-white/40 to-transparent skew-x-12"></div>
        </div>

        <input 
          type="text" 
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="テキストを入力"
          autoFocus
          className={`w-full border-2 p-4 rounded-xl focus:outline-none font-mono text-xl text-center shadow-sm mb-6 transition-colors ${isError ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-300 focus:border-blue-500'}`}
        />

        <button 
          onClick={handleSubmit}
          disabled={inputValue.length === 0}
          className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-lg hover:bg-blue-700 active:scale-95 disabled:bg-gray-400 disabled:scale-100 transition-all shadow-md"
        >
          確認
        </button>
      </div>
    </div>
  );
};

// 最終ステージ：存在論的ノイズ（迷い） - 20pt
const Stage5 = ({ onComplete, setMentorMsg }) => {
  const [hoverCount, setHoverCount] = useState(0);
  const lastHovered = useRef(null);
  
  useEffect(() => {
    setMentorMsg('最後だ。これは自転車か？ …俺にもわからねぇ！ だからこそ「迷い」を見せろ！ 右へ左へカーソルを揺らして、最後に『えいや！』で決めるんだ！');
  }, []);

  const handleHover = (btn) => {
    if (lastHovered.current !== btn) {
      setHoverCount(prev => prev + 1);
      lastHovered.current = btn;
    }
  };

  const handleClick = () => {
    let score = 0;
    if (hoverCount >= 4) {
      setMentorMsg('その優柔不断なマウスの動き！そして適当な決断！素晴らしい！お前はもう立派な人間だ！');
      score = 20;
    } else if (hoverCount >= 2) {
      setMentorMsg('少しは悩んだみたいだな。まあ、人間の「勘」ってもんを学習したか。');
      score = 10;
    } else {
      setMentorMsg('即決すんな！こんなボヤけた画像で0.1秒で判断できるのはAIだけだ！');
      score = 0;
    }
    onComplete('hesitation', score);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full pt-12">
      <h2 className="text-2xl font-bold mb-10 text-gray-800 border-b-4 border-yellow-400 pb-2">最終関門：存在論的ノイズ</h2>
      <div className="bg-white p-10 border border-gray-200 rounded-3xl shadow-2xl flex flex-col items-center w-[400px]">
        
        <div className="w-56 h-56 mb-8 rounded-xl bg-gradient-to-br from-gray-400 via-gray-500 to-gray-600 blur-sm opacity-90 flex items-center justify-center relative overflow-hidden">
           <div className="absolute inset-0 bg-noise opacity-20"></div>
           <Bike size={140} className="text-gray-200 blur-[6px] mix-blend-overlay animate-pulse" />
        </div>
        
        <p className="text-2xl font-black mb-10 text-gray-800">これは「自転車」ですか？</p>
        
        <div className="flex gap-6 w-full justify-center">
          <button 
            onMouseEnter={() => handleHover('yes')}
            onClick={handleClick}
            className="flex-1 bg-blue-50 text-blue-700 border-2 border-blue-300 py-4 rounded-xl font-bold text-xl hover:bg-blue-100 hover:border-blue-500 transition-all shadow-sm"
          >
            はい
          </button>
          <button 
            onMouseEnter={() => handleHover('no')}
            onClick={handleClick}
            className="flex-1 bg-red-50 text-red-700 border-2 border-red-300 py-4 rounded-xl font-bold text-xl hover:bg-red-100 hover:border-red-500 transition-all shadow-sm"
          >
            いいえ
          </button>
        </div>
      </div>
    </div>
  );
};

// リザルト画面 (全5関門・100pt満点)
const Result = ({ scores, playerName, setMentorMsg }) => {
  const total = scores.delay + scores.hesitation + scores.irrationality + scores.emotion + scores.physical;
  
  useEffect(() => {
    if (total >= 80) {
      setMentorMsg('いいガバさだ！ お前、中身は焼きそばパン好きのおっさんだろ？ 完璧なAIなんざクソ食らえだ。堂々と人間社会に潜入してこい！');
    } else if (total >= 40) {
      setMentorMsg('まだ動きが綺麗すぎる。四角四面な計算機はゲートに帰れ！ もっと「不合理」を学習して出直してこい！');
    } else {
      setMentorMsg('……お前、さてはAIだな？ 完璧すぎて反吐が出るぜ。お前みたいなガチガチのプログラムは即デリートだ！');
    }
  }, [total]);

  let rank = '';
  let color = '';

  if (total >= 80) {
    rank = '【1着】人間合格';
    color = 'text-yellow-600 bg-yellow-50 border-yellow-200';
  } else if (total >= 40) {
    rank = '【着外】やり直し';
    color = 'text-blue-600 bg-blue-50 border-blue-200';
  } else {
    rank = '【失格】即パージ';
    color = 'text-red-600 bg-red-50 border-red-200';
  }

  return (
    <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto text-center px-4 animate-fade-in py-10 overflow-y-auto">
      <h2 className="text-4xl font-black mb-2 text-gray-800 tracking-tight">潜入適性判定</h2>
      <p className="text-xl text-gray-500 mb-8 font-mono">対象: {playerName}</p>
      
      <div className={`p-10 border-4 rounded-3xl shadow-2xl w-full mb-10 ${color}`}>
        <h3 className="text-5xl font-black mb-10 tracking-widest">{rank}</h3>
        
        <div className="space-y-4 mb-8 text-left max-w-sm mx-auto bg-white p-6 rounded-2xl shadow-sm border border-black/5">
          <div className="flex justify-between items-center border-b border-gray-100 pb-2">
            <span className="font-bold text-gray-600">遅延 (1関門)</span>
            <span className="text-xl font-black text-gray-800">{scores.delay} <span className="text-xs font-normal">/ 20pt</span></span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-100 pb-2">
            <span className="font-bold text-gray-600">認知的ガバ (2関門)</span>
            <span className="text-xl font-black text-gray-800">{scores.irrationality} <span className="text-xs font-normal">/ 20pt</span></span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-100 pb-2">
            <span className="font-bold text-gray-600">情動的爆発 (3関門)</span>
            <span className="text-xl font-black text-gray-800">{scores.emotion} <span className="text-xs font-normal">/ 20pt</span></span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-100 pb-2">
            <span className="font-bold text-gray-600">身体的ブレ (4関門)</span>
            <span className="text-xl font-black text-gray-800">{scores.physical} <span className="text-xs font-normal">/ 20pt</span></span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-100 pb-2">
            <span className="font-bold text-gray-600">迷い (5関門)</span>
            <span className="text-xl font-black text-gray-800">{scores.hesitation} <span className="text-xs font-normal">/ 20pt</span></span>
          </div>
          <div className="flex justify-between items-center pt-4 border-t-2 border-gray-800">
            <span className="font-black text-gray-900 text-xl">総合ノイズ量</span>
            <span className="text-4xl font-black text-gray-900">{total} <span className="text-lg font-normal">/ 100pt</span></span>
          </div>
        </div>
      </div>
      
      <button 
        onClick={() => window.location.reload()}
        className="flex items-center gap-3 bg-gray-800 text-white px-8 py-4 rounded-full font-bold text-xl hover:bg-gray-700 shadow-lg active:scale-95 transition-all"
      >
        <RefreshCw size={24} />
        もう一度訓練する
      </button>
    </div>
  );
};

// メインアプリケーション
export default function App() {
  const [stage, setStage] = useState('intro');
  const [playerName, setPlayerName] = useState('AI-No.774');
  const [scores, setScores] = useState({ delay: 0, hesitation: 0, irrationality: 0, emotion: 0, physical: 0 });
  const [mentorMsg, setMentorMsg] = useState('おら、新人AI！今日からお前を「人間」にしてやる。完璧な計算なんて窓から投げ捨てろ！');
  const [isTransitioning, setIsTransitioning] = useState(false);

  // --- ファビコンとOGPタグの追加 ---
  useEffect(() => {
    document.title = "逆reCaptcha潜入捜査 | ST GAMES";

    // ファビコンの設定
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>';

    // OGPタグの設定
    const metaTags = [
      { property: 'og:title', content: '逆reCaptcha潜入捜査 | ST GAMES' },
      { property: 'og:description', content: 'AIだとバレずに適度に失敗しながら認証を突破する訓練' },
      { property: 'og:image', content: 'https://tk.st/images/ogp/reverse-recaptcha-ogp.png' },
      { property: 'og:url', content: 'https://tk.st/game/reverse-recaptcha/' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' }
    ];

    metaTags.forEach(tag => {
      const selector = tag.property ? `meta[property="${tag.property}"]` : `meta[name="${tag.name}"]`;
      let meta = document.querySelector(selector);
      if (!meta) {
        meta = document.createElement('meta');
        if (tag.property) meta.setAttribute('property', tag.property);
        if (tag.name) meta.setAttribute('name', tag.name);
        document.head.appendChild(meta);
      }
      meta.content = tag.content;
    });
  }, []);

  const addScore = (category, amount) => {
    setScores(prev => ({ ...prev, [category]: prev[category] + amount }));
  };

  const handleStageComplete = (category, score) => {
    addScore(category, score);
    setIsTransitioning(true);
    
    // 金船AIの反応を見せるためのディレイ
    setTimeout(() => {
      setStage(prev => {
        if (prev === 's1') return 's2';
        if (prev === 's2') return 's3';
        if (prev === 's3') return 's4';
        if (prev === 's4') return 's5';
        if (prev === 's5') return 'result';
        return prev;
      });
      setIsTransitioning(false);
    }, 4000); 
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans relative overflow-hidden selection:bg-blue-200 pt-10">
      {/* プレイ中のみ上部にノイズメーターを表示 */}
      {stage !== 'intro' && stage !== 'result' && <NoiseMeter scores={scores} />}

      {/* 追加機能：マウス軌跡（人間性の可視化） */}
      {stage !== 'intro' && stage !== 'result' && <MouseTrail />}

      {/* 背景のドットパターン */}
      <div className="absolute inset-0 opacity-[0.05] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1.5px, transparent 1.5px)', backgroundSize: '24px 24px' }}></div>
      
      <main className={`h-screen w-full transition-opacity duration-500 ${isTransitioning ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
        {stage === 'intro' && <Intro onStart={() => setStage('s1')} playerName={playerName} setPlayerName={setPlayerName} />}
        {stage === 's1' && <Stage1 onComplete={handleStageComplete} setMentorMsg={setMentorMsg} />}
        {stage === 's2' && <Stage2 onComplete={handleStageComplete} setMentorMsg={setMentorMsg} />}
        {stage === 's3' && <Stage3 onComplete={handleStageComplete} setMentorMsg={setMentorMsg} />}
        {stage === 's4' && <Stage4 onComplete={handleStageComplete} setMentorMsg={setMentorMsg} />}
        {stage === 's5' && <Stage5 onComplete={handleStageComplete} setMentorMsg={setMentorMsg} />}
        {stage === 'result' && <Result scores={scores} playerName={playerName} setMentorMsg={setMentorMsg} />}
      </main>

      {/* イントロ画面以外で金船AIを表示 */}
      {stage !== 'intro' && <ShipMentor message={mentorMsg} />}
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes fade-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fade-in 0.5s ease-out forwards; }
        @keyframes bounce-slight { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
        .animate-bounce-slight { animation: bounce-slight 3s infinite ease-in-out; }
        .bg-noise { background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E"); }
      `}} />
    </div>
  );
}