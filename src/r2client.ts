import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

export interface R2Config {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class R2Client {
  s3: S3Client;
  bucket: string;

  constructor(cfg: R2Config) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      region: cfg.region || "auto",
      endpoint: cfg.endpoint,
      credentials: cfg.accessKeyId
        ? {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey ?? "",
          }
        : undefined,
      forcePathStyle: cfg.forcePathStyle ?? true,
    });
  }

  async putObject(
    key: string,
    body: Buffer | string,
    contentType?: string,
    tagging?: string,
    ifMatch?: string,
    ifNoneMatch?: string,
  ) {
    const params: PutObjectCommandInput = { Bucket: this.bucket, Key: key, Body: body };
    if (contentType) params.ContentType = contentType;
    if (tagging) params.Tagging = tagging;
    if (ifMatch) params.IfMatch = ifMatch;
    if (ifNoneMatch) params.IfNoneMatch = ifNoneMatch;
    const cmd = new PutObjectCommand(params);
    try {
      return await this.s3.send(cmd);
    } catch (err: unknown) {
      const normalized = err as {
        Code?: string;
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const code = normalized?.Code || normalized?.name || normalized?.$metadata?.httpStatusCode;
      if (tagging && (code === "NotImplemented" || normalized?.$metadata?.httpStatusCode === 501)) {
        delete params.Tagging;
        return await this.s3.send(new PutObjectCommand(params));
      }
      if (
        normalized &&
        (normalized.$metadata?.httpStatusCode === 412 || normalized.Code === "PreconditionFailed")
      ) {
        const preconditionError = new Error("PreconditionFailed") as Error & { code?: string };
        preconditionError.code = "PreconditionFailed";
        throw preconditionError;
      }
      throw err;
    }
  }

  async getObject(key: string) {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    try {
      return await this.s3.send(cmd);
    } catch (err: unknown) {
      const normalized = err as {
        Code?: string;
        name?: string;
        code?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const code = normalized?.Code || normalized?.name || normalized?.code;
      if (
        code === "NoSuchKey" ||
        code === "NotFound" ||
        normalized?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async headObject(key: string) {
    const cmd = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    try {
      return await this.s3.send(cmd);
    } catch (err: unknown) {
      const normalized = err as {
        Code?: string;
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        normalized?.Code === "NotFound" ||
        normalized?.name === "NotFound" ||
        normalized?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      return null;
    }
  }

  async getJsonWithEtag<T>(key: string): Promise<{ body: T; etag: string | null } | null> {
    const res = await this.getObject(key);
    if (!res?.Body) {
      return null;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return {
      body: JSON.parse(text) as T,
      etag: normalizeEtag(res.ETag),
    };
  }

  async deleteObject(key: string) {
    return await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listPrefix(prefix: string, maxKeys = 100) {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: maxKeys }),
    );
    return res.Contents || [];
  }

  async getBucketLifecycleRules(): Promise<LifecycleRule[]> {
    try {
      const res = await this.s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
      );
      return res.Rules || [];
    } catch (err: unknown) {
      const normalized = err as {
        Code?: string;
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      const code = normalized?.Code || normalized?.name || normalized?.$metadata?.httpStatusCode;
      if (
        code === "NoSuchLifecycleConfiguration" ||
        code === "NoSuchBucketLifecycleConfiguration" ||
        normalized?.$metadata?.httpStatusCode === 404
      ) {
        return [];
      }
      throw err;
    }
  }

  async putBucketLifecycleRules(rules: LifecycleRule[]) {
    return await this.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: { Rules: rules },
      }),
    );
  }
}

function normalizeEtag(etag?: string | null): string | null {
  if (!etag) return null;
  return etag.replace(/^"|"$/g, "") || null;
}
