async function importOpenCV() {
  const cv = await import('./wasm.js').then((r) => r.cv);
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
async function scan(input, options = {}) {
  const { cv, qrcode_detector } = await getOpenCV();
  const inputImage = cv.imread(input, cv.IMREAD_GRAYSCALE);
  const points_vec = new cv.MatVector();
  const res = qrcode_detector.detectAndDecode(inputImage, points_vec);
  const points = points_vec.get(0);
  const rect = points ? {
    x: points.floatAt(0),
    y: points.floatAt(1),
    width: points.floatAt(4) - points.floatAt(0),
    height: points.floatAt(5) - points.floatAt(1)
  } : void 0;
  let rectCanvas;
  if (rect && options.includeRectCanvas) {
    rectCanvas = document.createElement("canvas");
    const dst = inputImage.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height));
    cv.imshow(rectCanvas, dst);
    dst.delete();
  }
  inputImage.delete();
  return {
    text: res.get(0),
    rect,
    rectCanvas
  };
}
async function loadModels(cv) {
  const models = await import('./wasm.js');
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
