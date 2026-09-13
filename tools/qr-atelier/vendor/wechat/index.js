// tk.st: 読み込みに失敗したモジュールはブラウザのモジュールマップに残り、
// 同じ URL では二度と読み直せない。再試行時に親へ付けたクエリを子にも渡して、
// キャッシュを外せるようにしている（元は import('./wasm.mjs')）。
const __q = new URL(import.meta.url).search;
async function importOpenCV() {
  const cv = await import('./wasm.js' + __q).then((r) => r.cv);
  await cv.ready;
  const qrcode_detector = await loadModels(cv);
  return {
    cv,
    qrcode_detector
  };
}
let _promise;
async function getOpenCV() {
  if (!_promise)
    _promise = importOpenCV();
  return _promise;
}
async function ready() {
  await getOpenCV();
}
function release(value) {
  if (value && typeof value.delete === "function") value.delete();
}
async function scan(input, options = {}) {
  const { cv, qrcode_detector } = await getOpenCV();
  let inputImage;
  let points_vec;
  let res;
  let points;
  let dst;
  let roiRect;
  let text = "";
  let rect;
  let rectCanvas;
  try {
    inputImage = cv.imread(input, cv.IMREAD_GRAYSCALE);
    points_vec = new cv.MatVector();
    res = qrcode_detector.detectAndDecode(inputImage, points_vec);
    if (!res || typeof res.size !== "function" || res.size() > 0) text = res ? res.get(0) : "";
    if (!points_vec || typeof points_vec.size !== "function" || points_vec.size() > 0) {
      points = points_vec ? points_vec.get(0) : null;
    }
    rect = points ? {
      x: points.floatAt(0),
      y: points.floatAt(1),
      width: points.floatAt(4) - points.floatAt(0),
      height: points.floatAt(5) - points.floatAt(1)
    } : void 0;
    if (rect && options.includeRectCanvas) {
      rectCanvas = document.createElement("canvas");
      roiRect = new cv.Rect(rect.x, rect.y, rect.width, rect.height);
      dst = inputImage.roi(roiRect);
      cv.imshow(rectCanvas, dst);
    }
  } finally {
    // OpenCV.js / Embind のオブジェクトは GC では WASM ヒープから解放されない。
    release(dst);
    release(roiRect);
    release(points);
    release(res);
    release(points_vec);
    release(inputImage);
  }
  return {
    text,
    rect,
    rectCanvas
  };
}
async function loadModels(cv) {
  const models = await import('./wasm.js' + __q);
  cv.FS_createDataFile("/", "detect.prototxt", models.detect_prototxt, true, false, false);
  cv.FS_createDataFile("/", "detect.caffemodel", models.detect_caffemodel, true, false, false);
  cv.FS_createDataFile("/", "sr.prototxt", models.sr_prototxt, true, false, false);
  cv.FS_createDataFile("/", "sr.caffemodel", models.sr_caffemodel, true, false, false);
  const qrcode_detector = new cv.wechat_qrcode_WeChatQRCode(
    "detect.prototxt",
    "detect.caffemodel",
    "sr.prototxt",
    "sr.caffemodel"
  );
  return qrcode_detector;
}

export { ready, scan };
