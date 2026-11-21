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
  } catch {
    // 浏览器禁用会话存储时，凭据只存在于原链接。
  }
}

function readLogin(storage, key) {
  try {
    const login = JSON.parse(globalThis[storage].getItem(key));
    if (
      login &&
      typeof login.token === "string" &&
      tokenFormat.test(login.token)
    )
      return login;
  } catch {
    // 站点数据可能已损坏或被浏览器禁用。
  }
}

function removeLogin(storage, key) {
  try {
    globalThis[storage].removeItem(key);
  } catch {
    // 浏览器可能限制站点存储。
  }
}

export async function openP2pLoginStorage(link) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(link),
  );
  const key =
    loginKey + ":" + btoa(String.fromCharCode(...new Uint8Array(digest)));
  const tabLogin = () => {
    const login = readLogin("sessionStorage", loginKey);
    if (login?.link === link) return login;
  };
  const storedLogin = () => readLogin("localStorage", key);
  const clearTab = (token) => {
    const login = tabLogin();
    if (login && (!token || login.token === token))
      removeLogin("sessionStorage", loginKey);
  };
  return {
    read() {
      const login = storedLogin();
      if (login?.expiresAt > Date.now()) return login.token;
      if (login) removeLogin("localStorage", key);
      return tabLogin()?.token || "";
    },
    save(token, expiresAt, restoring = false) {
      try {
        if (!restoring || !(storedLogin()?.expiresAt > Date.now()))
          localStorage.setItem(key, JSON.stringify({ token, expiresAt }));
      } catch {
        try {
          sessionStorage.setItem(loginKey, JSON.stringify({ link, token }));
        } catch {
          // 浏览器禁用存储时，会话凭据随当前页面保留在内存中。
        }
        return;
      }
      clearTab();
    },
    clear(token) {
      const login = storedLogin();
      if (login && (!token || login.token === token))
        removeLogin("localStorage", key);
      clearTab(token);
    },
  };
}
