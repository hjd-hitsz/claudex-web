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

export function TotpSetupSteps({ duringLogin }) {
  return (
    <ol className="totp-steps">
      <li>
        在服务电脑上用运行 Claudex Web 的账户打开终端，执行命令生成二维码。
        <Command action="setup" label="复制绑定命令" />
        <span className="totp-source">
          源码运行时用 <code>npm run auth -- setup</code>。
        </span>
      </li>
      <li>打开手机上的验证器 App，扫描终端中的二维码。</li>
      <li>
        打开验证器中新添加的 Claudex Web 项，
        {duringLogin
          ? "把当前 6 位动态码填到上方。"
          : "从其他设备登录或打开 P2P 授权链接时，在网页输入当前 6 位动态码。"}
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
        <h4>绑定验证器</h4>
        {status === "enabled" && (
          <p>更换验证器时，先按下方说明关闭双重验证。</p>
        )}
        <TotpSetupSteps />
        <h4>关闭双重验证</h4>
        <p>
          在服务电脑的终端执行命令，输入 <code>yes</code>{" "}
          确认。下次登录时使用系统密码。
        </p>
        <Command action="disable" label="复制关闭命令" />
        <span className="totp-source">
          源码运行时用 <code>npm run auth -- disable</code>。
        </span>
      </details>
    </div>
  );
}
