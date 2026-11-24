import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import {
  openTotpStore,
  prepareAuthDirectory,
} from "../server/src/auth-totp.mjs";

function terminalQr(uri) {
  const { modules } = QRCode.create(uri);
  const margin = 4;
  const glyphs = [" ", "▄", "▀", "█"];
  const dark = (row, column) =>
    row >= 0 &&
    row < modules.size &&
    column >= 0 &&
    column < modules.size &&
    modules.get(row, column);
  const lines = [];
  for (let row = -margin; row < modules.size + margin; row += 2) {
    let line = "\x1b[30;47m";
    for (let column = -margin; column < modules.size + margin; column++) {
      const top = dark(row, column) ? 2 : 0;
      const bottom = dark(row + 1, column) ? 1 : 0;
      line += glyphs[top + bottom];
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

export async function runAuthCommand([command, name, ...extra], config) {
  if (
    extra.length ||
    (command === "setup" && name === "") ||
    (command === "revoke" && !name) ||
    (!["setup", "revoke"].includes(command) && name !== undefined) ||
    !["setup", "list", "revoke", "disable"].includes(command)
  )
    throw new Error(
      "用法：claudex-web auth setup [名称] | list | revoke <名称> | disable",
    );
  if (command === "disable") {
    const input = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const answer = await input.question(
        "关闭后，网页将只验证系统密码，并清除全部验证器绑定。输入 yes 确认：",
      );
      if (answer.trim() !== "yes") return;
    } finally {
      input.close();
    }
  }
  const totp = await openTotpStore(await prepareAuthDirectory(config));
  try {
    if (command === "disable") {
      totp.disable();
      console.log("双重验证已关闭。");
      return;
    }
    if (command === "list") {
      const entries = totp.list();
      if (!entries.length) console.log("暂无已添加的验证器。");
      for (const { name, enabled } of entries)
        console.log(`${name}\t${enabled ? "已绑定" : "待验证"}`);
      return;
    }
    if (command === "revoke") {
      totp.revoke(name);
      console.log(`已撤销验证器 ${name.trim()}。`);
      return;
    }
    const uri = totp.setup(userInfo().username, name);
    console.log(terminalQr(uri));
    console.log(
      "用验证器 App 扫描二维码，再把 6 位动态码输入 Claudex Web。二维码仅供本人绑定。",
    );
  } finally {
    totp.close();
  }
}
