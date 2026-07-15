import { Algorithm, hash } from "@node-rs/argon2";

const password = String(process.env.ADMIN_PASSWORD || "");
if (password.length < 12) {
  console.error("Set ADMIN_PASSWORD dengan minimal 12 karakter sebelum menjalankan perintah ini.");
  process.exitCode = 1;
} else {
  const value = await hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
  process.stdout.write(value);
}
