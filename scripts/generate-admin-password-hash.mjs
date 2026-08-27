import { pbkdf2Sync, randomBytes } from "node:crypto";

function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (value += chunk));
      process.stdin.on("end", () => resolve(value.replace(/[\r\n]+$/, "")));
    });
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      if (chunk === "\u0003") {
        finish();
        reject(new Error("已取消"));
      } else if (chunk === "\r" || chunk === "\n") {
        finish();
        resolve(value);
      } else if (chunk === "\u007f" || chunk === "\b") {
        value = value.slice(0, -1);
      } else if (!chunk.startsWith("\u001b")) {
        value += chunk;
      }
    };
    process.stdin.on("data", onData);
  });
}

const password = await readHidden("管理员密码：");
if (password.length < 12) {
  throw new Error("管理员密码至少需要 12 个字符");
}
const confirmation = await readHidden("再次输入密码：");
if (password !== confirmation) throw new Error("两次输入的密码不一致");

// Cloudflare Workers' production runtime rejects larger PBKDF2 workloads on
// lower CPU limits. This is also the verifier's enforced minimum.
const iterations = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
console.log(
  `pbkdf2-sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`,
);
