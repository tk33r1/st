// ページのmeta CSPを引き継ぐBlob Workerとして起動する。最適化はページのDOMに触れない。
const library = import(new URL('/assets/vendor/svgo@3.3.5/svgo.browser.js', self.location.origin).href);
self.onmessage = async ({ data }) => {
  try {
    if (typeof data?.svg !== 'string' || data.svg.length > 5 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(data.svg)) {
      throw new Error('invalid SVG');
    }
    const { optimize } = await library;
    const result = optimize(data.svg, data.config);
    self.postMessage({ ok: true, svg: result.data });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error?.message || 'optimize failed').slice(0, 300) });
  }
};
