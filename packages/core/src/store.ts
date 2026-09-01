import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { OperationRecord } from "./types";

export type OperationStore = {
  get(operationId: string): OperationRecord | undefined;
  set(operationId: string, record: OperationRecord): void;
  has(operationId: string): boolean;
  clear(): void;
  size(): number;
};

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(key: Buffer, ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export class EncryptedOperationStore implements OperationStore {
  private data = new Map<string, string>();
  private key: Buffer;

  constructor(encryptionSecret: string) {
    this.key = deriveKey(encryptionSecret);
  }

  get(operationId: string): OperationRecord | undefined {
    const encrypted = this.data.get(operationId);
    if (!encrypted) return undefined;
    return JSON.parse(decrypt(this.key, encrypted)) as OperationRecord;
  }

  set(operationId: string, record: OperationRecord): void {
    this.data.set(operationId, encrypt(this.key, JSON.stringify(record)));
  }

  has(operationId: string): boolean {
    return this.data.has(operationId);
  }

  clear(): void {
    this.data.clear();
  }

  size(): number {
    return this.data.size;
  }
}

export class MemoryOperationStore implements OperationStore {
  private data = new Map<string, OperationRecord>();

  get(operationId: string): OperationRecord | undefined {
    const record = this.data.get(operationId);
    return record ? structuredClone(record) : undefined;
  }

  set(operationId: string, record: OperationRecord): void {
    this.data.set(operationId, structuredClone(record));
  }

  has(operationId: string): boolean {
    return this.data.has(operationId);
  }

  clear(): void {
    this.data.clear();
  }

  size(): number {
    return this.data.size;
  }
}
