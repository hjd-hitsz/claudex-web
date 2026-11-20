const storageKey = "cx-p2p-link";
const loginKey = "cx-p2p-login";
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
let viewId;

export const p2pDownloadFrame = "claudex-p2p-download";

export function isP2pPage() {
  return globalThis.location?.pathname === "/p2p";
}

export function p2pViewId() {
  return (viewId ??= crypto.randomUUID());
}

export function p2pFrameUrl(url) {
  const target = new URL(url, location.origin);
  target.searchParams.set("p2p-view", p2pViewId());
  return target.pathname + target.search;
}

export function readP2pToken() {
  const fragment = location.hash.slice(1);
  if (tokenFormat.test(fragment)) {
    try {
      sessionStorage.setItem(storageKey, fragment);
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    } catch {
      // 浏览器禁用会话存储时，保留原链接以便刷新。
    }
    return fragment;
  }
  if (fragment && !new URLSearchParams(fragment).has("notificationThread"))
    return "";
  try {
    const saved = sessionStorage.getItem(storageKey);
    return tokenFormat.test(saved) ? saved : "";
  } catch {
    return "";
  }
}

export function forgetP2pToken() {
  if (location.hash) {
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }
  try {
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(loginKey);
  } catch {
    // 浏览器禁用会话存储时，凭据只存在于原链接。
  }
}

export function readP2pLogin(link) {
  try {
    const login = JSON.parse(sessionStorage.getItem(loginKey));
    if (login?.link === link && tokenFormat.test(login.token))
      return login.token;
  } catch {
    // 会话存储不可用时，可在当前页面登录。
  }
  return "";
}

export function saveP2pLogin(link, token) {
  try {
    if (token)
      sessionStorage.setItem(loginKey, JSON.stringify({ link, token }));
    else sessionStorage.removeItem(loginKey);
  } catch {
    // 当前页面在内存中保留会话凭据。
  }
}
