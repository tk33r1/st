/**
 * Basic Auth Worker
 * 認証情報は wrangler secret で設定してください:
 *   wrangler secret put BASIC_AUTH_USER
 *   wrangler secret put BASIC_AUTH_PASS
 */

export default {
  async fetch(request, env) {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return unauthorizedResponse();
    }

    let credentials;
    try {
      credentials = atob(authHeader.slice(6));
    } catch {
      return unauthorizedResponse();
    }

    const colonIndex = credentials.indexOf(':');
    if (colonIndex === -1) {
      return unauthorizedResponse();
    }

    const username = credentials.slice(0, colonIndex);
    const password = credentials.slice(colonIndex + 1);

    // タイミング攻撃対策のため timingSafeEqual で比較
    const encoder = new TextEncoder();
    const expectedUser = encoder.encode(env.BASIC_AUTH_USER ?? '');
    const expectedPass = encoder.encode(env.BASIC_AUTH_PASS ?? '');
    const actualUser   = encoder.encode(username);
    const actualPass   = encoder.encode(password);

    const userMatch = timingSafeEqual(expectedUser, actualUser);
    const passMatch = timingSafeEqual(expectedPass, actualPass);

    if (!userMatch || !passMatch) {
      return unauthorizedResponse();
    }

    // 認証通過 → オリジンにそのままリクエストを転送
    return fetch(request);
  },
};

function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Protected", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=UTF-8',
    },
  });
}

/**
 * 長さが異なる場合も含めてタイミングセーフな比較
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    // 長さが違っても必ず全バイト比較してから false を返す（タイミング漏洩防止）
    let result = 1;
    const len = Math.max(a.length, b.length);
    const paddedA = new Uint8Array(len);
    const paddedB = new Uint8Array(len);
    paddedA.set(a);
    paddedB.set(b);
    for (let i = 0; i < len; i++) {
      result |= paddedA[i] ^ paddedB[i];
    }
    return false; // 長さ不一致は常に false
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
