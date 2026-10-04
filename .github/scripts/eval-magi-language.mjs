// 旧77文の原本が残っていないため、期待言語を固定した別の77文で評価する。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const ctx = vm.createContext({ aiModels: JSON.parse(read('config/ai-models.json')) });
const strip = s => s.replace(/^import .*;\r?\n/gm, '').replace(/export const /g, 'const ').replace(/export (?=(?:async )?function)/g, '');
vm.runInContext(['languages.js', 'personas.js', 'classification.js'].map(p => strip(read('workers/magi2/' + p))).join('\n')
  + '\nglobalThis.cfg=INTENT_CLASSIFY;globalThis.payload=classificationPayload;globalThis.accept=acceptedChoice;', ctx);
const cfg = ctx.cfg;
const key = process.env[cfg.key] || read('workers/magi2/.dev.vars').match(/^\s*MAGI_TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
assert(key, 'TypeSafe key is required');
const samples = {
  ja: ['新しい仕事を始める前に、何を準備すればよいですか？', '週末は家族と公園を散歩してゆっくり過ごしたいです。', '毎日の勉強を続けるための工夫を一緒に考えてください。'],
  en: ['How can I prepare before starting a new job?', 'I would like to take a relaxing walk with my family this weekend.', 'Please help me build a daily study habit.'],
  zh: ['开始一份新工作之前，我应该准备什么？', '这个周末我想和家人一起去公园散步。', '请帮我想想怎样养成每天学习的习惯。'],
  ko: ['새로운 일을 시작하기 전에 무엇을 준비해야 할까요?', '이번 주말에는 가족과 함께 공원에서 산책하고 싶어요.', '매일 공부하는 습관을 만드는 방법을 함께 생각해 주세요.'],
  fr: ['Comment puis-je me préparer avant de commencer un nouveau travail ?', 'Ce week-end, je voudrais me promener tranquillement avec ma famille.', 'Aidez-moi à prendre une bonne habitude de travail chaque jour.'],
  es: ['¿Cómo puedo prepararme antes de empezar un nuevo trabajo?', 'Este fin de semana quiero pasear tranquilamente con mi familia.', 'Ayúdame a crear el hábito de estudiar todos los días.'],
  de: ['Wie kann ich mich auf eine neue Arbeitsstelle vorbereiten?', 'Am Wochenende möchte ich mit meiner Familie im Park spazieren gehen.', 'Bitte hilf mir, jeden Tag regelmäßig zu lernen.'],
  it: ['Come posso prepararmi prima di iniziare un nuovo lavoro?', 'Questo fine settimana vorrei passeggiare con la mia famiglia.', 'Aiutami a trovare un metodo per studiare ogni giorno.'],
  pt: ['Como posso me preparar antes de começar um novo trabalho?', 'Neste fim de semana quero passear no parque com minha família.', 'Ajude-me a criar o hábito de estudar todos os dias.'],
  ru: ['Как мне подготовиться перед началом новой работы?', 'В эти выходные я хочу погулять в парке вместе с семьёй.', 'Помоги мне выработать привычку заниматься каждый день.'],
  uk: ['Як підготуватися перед початком нової роботи?', 'Цими вихідними я хочу прогулятися в парку зі своєю родиною.', 'Допоможіть мені виробити звичку вчитися щодня.'],
  ar: ['كيف أستعد قبل بدء عمل جديد؟', 'أريد أن أتمشى مع عائلتي في الحديقة في نهاية هذا الأسبوع.', 'ساعدني في تكوين عادة الدراسة كل يوم.'],
  hi: ['नई नौकरी शुरू करने से पहले मुझे क्या तैयारी करनी चाहिए?', 'इस सप्ताहांत मैं अपने परिवार के साथ पार्क में घूमना चाहता हूँ।', 'हर दिन पढ़ाई करने की आदत बनाने में मेरी मदद करें।'],
  bn: ['নতুন কাজ শুরু করার আগে কীভাবে প্রস্তুতি নেওয়া উচিত?', 'এই সপ্তাহান্তে আমি পরিবারের সঙ্গে পার্কে হাঁটতে চাই।', 'প্রতিদিন পড়াশোনা করার অভ্যাস গড়ে তুলতে আমাকে সাহায্য করুন।'],
  th: ['ก่อนเริ่มงานใหม่ฉันควรเตรียมตัวอย่างไร', 'วันหยุดสุดสัปดาห์นี้ฉันอยากเดินเล่นในสวนกับครอบครัว', 'ช่วยคิดวิธีสร้างนิสัยอ่านหนังสือทุกวันให้หน่อย'],
  vi: ['Tôi nên chuẩn bị gì trước khi bắt đầu công việc mới?', 'Cuối tuần này tôi muốn đi dạo trong công viên cùng gia đình.', 'Hãy giúp tôi xây dựng thói quen học tập mỗi ngày.'],
  id: ['Bagaimana saya harus mempersiapkan diri sebelum memulai pekerjaan baru?', 'Akhir pekan ini saya ingin berjalan santai di taman bersama keluarga.', 'Bantu saya membangun kebiasaan belajar setiap hari.'],
  ms: ['Apakah persediaan yang perlu saya lakukan sebelum memulakan pekerjaan baharu?', 'Hujung minggu ini saya ingin bersiar-siar di taman bersama keluarga saya.', 'Tolong bantu saya membina tabiat belajar setiap hari.'],
  tr: ['Yeni bir işe başlamadan önce nasıl hazırlanmalıyım?', 'Bu hafta sonu ailemle parkta sakin bir yürüyüş yapmak istiyorum.', 'Her gün ders çalışma alışkanlığı kazanmama yardım eder misin?'],
  nl: ['Hoe kan ik me voorbereiden voordat ik aan een nieuwe baan begin?', 'Dit weekend wil ik met mijn gezin rustig wandelen in het park.', 'Help me om de gewoonte op te bouwen elke dag te studeren.'],
  pl: ['Jak przygotować się przed rozpoczęciem nowej pracy?', 'W ten weekend chcę spokojnie pospacerować z rodziną po parku.', 'Pomóż mi wyrobić nawyk codziennej nauki.'],
  sv: ['Hur kan jag förbereda mig innan jag börjar på ett nytt jobb?', 'I helgen vill jag ta en lugn promenad med min familj i parken.', 'Hjälp mig att skapa en vana att studera varje dag.'],
  da: ['Hvordan kan jeg forberede mig, før jeg begynder på et nyt arbejde?', 'I weekenden vil jeg gerne gå en rolig tur i parken med min familie.', 'Hjælp mig med at gøre det til en vane at studere hver dag.'],
  fi: ['Miten voin valmistautua ennen uuden työn aloittamista?', 'Tänä viikonloppuna haluan kävellä rauhassa puistossa perheeni kanssa.', 'Auta minua kehittämään tapa opiskella joka päivä.'],
  ca: ['Com em puc preparar abans de començar una feina nova?', 'Aquest cap de setmana m’agradaria passejar tranquil·lament amb la meva família.', 'Ajuda’m a crear l’hàbit d’estudiar cada dia i a organitzar millor el meu temps.'],
};
const cases = Object.entries(samples).flatMap(([language, texts]) => texts.map(text => ({ language, text })));
cases.push({ language: 'ja', text: 'PDFを結合する方法を日本語で教えてください。' },
  { language: 'en', text: 'What do you think of サカナクション? Please explain your thoughts in English.' });
assert.equal(cases.length, 77);
for (const profile of ['chat', 'dj-request']) {
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const sample = cases[i], payload = ctx.payload({ profile, texts: [sample.text], seed: sample.text });
    const start = performance.now();
    const response = await fetch(cfg.endpoint, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200, 'language evaluation HTTP failure');
    const body = await response.json(), language = ctx.accept('language', body.answers?.language);
    results.push({ case: i + 1, expected: sample.language, language, confidence: body.answers?.language?.confidence,
      elapsed_ms: Math.round(performance.now() - start) });
  }
  const times = results.map(r => r.elapsed_ms).sort((a, b) => a - b), errors = results.filter(r => r.expected !== r.language);
  console.log(JSON.stringify({ profile, revision: cfg.revision, count: results.length, correct: results.length - errors.length,
    errors, median_ms: times[38], p90_ms: times[69], within_budget: times.filter(t => t <= cfg.timeout_ms).length / times.length }));
  assert(results.length - errors.length >= 76, '多言語の目標76/77に未達');
}
