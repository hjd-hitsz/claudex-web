import React, { useRef, useState } from "react";

function Command({ action, label }) {
  const command = "claudex-web auth " + action;
  const code = useRef(null);
  const [feedback, setFeedback] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setFeedback("已复制");
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code.current);
      selection.removeAllRanges();
      selection.addRange(range);
      setFeedback("已选中");
    }
  }
  return (
    <div className="totp-command">
      <code ref={code}>{command}</code>
      <button
        type="button"
        className="secondary"
        onClick={copy}
        aria-label={label}
      >
        {feedback || "复制"}
      </button>
      <span role="status" className="totp-copy-status">
        {feedback}
      </span>
    </div>
  );
}

export function TotpSetupSteps({ duringLogin, named }) {
  const action = named ? "setup 我的手机" : "setup";
  return (
    <ol className="totp-steps">
      <li>
        在服务电脑上用运行 Claudex Web 的账户打开终端，执行命令生成二维码。
        {named && " 每位使用者取一个独立名称，例如「我的手机」。"}
        <Command action={action} label="复制绑定命令" />
        <span className="totp-source">
          源码运行时用 <code>npm run auth -- {action}</code>。
        </span>
      </li>
      <li>打开手机上的验证器 App，扫描终端中的二维码。</li>
      <li>
        {duringLogin
          ? named
            ? "命名验证器需填写绑定时的名称和当前 6 位动态码。默认验证器只需动态码。"
            : "把验证器当前显示的 6 位动态码填到上方。"
          : "从其他设备登录或打开 P2P 授权链接时，在网页填写验证器名称和当前 6 位动态码。默认验证器只需动态码。"}
      </li>
    </ol>
  );
}

export function TotpSettings({ status }) {
  const label = {
    enabled: "双重验证（2FA）已启用",
    disabled: "双重验证（2FA）已关闭",
    setup: "双重验证（2FA）未绑定",
    pending: "双重验证（2FA）等待首次动态码验证",
  }[status];
  return (
    <div className="totp-settings">
      <p>{label}</p>
      <details className="totp-help">
        <summary>双重验证使用方法</summary>
        <h4>添加验证器</h4>
        <TotpSetupSteps named />
        <h4>查看或撤销验证器</h4>
        <p>在服务电脑上查看已添加的名称和绑定状态。</p>
        <Command action="list" label="复制列表命令" />
        <p>
          用 <code>claudex-web auth revoke &lt;名称&gt;</code>{" "}
          撤销指定验证器及其登录会话。
        </p>
        <h4>关闭双重验证</h4>
        <p>
          在服务电脑的终端执行命令，输入 <code>yes</code>{" "}
          确认。关闭后会清除全部绑定，下次登录使用系统密码。
        </p>
        <Command action="disable" label="复制关闭命令" />
        <span className="totp-source">
          源码运行时用 <code>npm run auth -- disable</code>。
        </span>
      </details>
    </div>
  );
}
