import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// S3-compatible blob storage. Works against AWS S3 or any compatible
// provider that uses virtual-hosted-style URLs.
//
// We assemble the public URL ourselves as `https://<bucket>.<host>/<key>`
// rather than taking a separate public-base-url env var: that's exactly
// the virtual-hosted layout S3/R2/etc. use, so we'd just be asking
// users to type the same thing twice.

const endpoint = process.env.S3_ENDPOINT;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const bucket = process.env.S3_BUCKET;

let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "S3 storage not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"
    );
  }
  cached = new S3Client({
    endpoint,
    // Region is meaningless for non-AWS S3-compatible providers (R2,
    // Minio, Tigris); they accept anything. Hardcode "auto" so users
    // don't have to set an env var that does nothing.
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
    // Virtual-hosted style by default (bucket in the host part, e.g.
    // https://my-bucket.t3.storageapi.dev/key.png) — matches AWS/R2.
    // Some providers (e.g. Lizard's managed S3, MinIO) only support
    // path-style; set S3_FORCE_PATH_STYLE=true for those.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return cached;
}

function publicUrlFor(key: string): string {
  // endpoint is checked in client(); guarded by isStorageConfigured at the
  // call site too. Cast non-null here to keep the URL builder sync.
  const u = new URL(endpoint!);
  return `${u.protocol}//${bucket}.${u.host}/${key}`;
}

export type UploadResult = { url: string; key: string };

export async function uploadPublicObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<UploadResult> {
  const c = client();
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
      ACL: "public-read",
    })
  );
  return { url: publicUrlFor(key), key };
}

export function isStorageConfigured(): boolean {
  return Boolean(endpoint && accessKeyId && secretAccessKey && bucket);
}

// Fetches an object using the same credentials we uploaded with. Some
// S3-compatible backends (e.g. Tigris) don't expose any public-read
// toggle and return 501 NotImplemented on PutBucketPolicy, so direct
// anonymous GETs to the bucket URL aren't possible. We stream objects
// through the API to keep share images publicly scrapable by Farcaster.
export async function getPublicObject(
  key: string
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const c = client();
  try {
    const res = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return {
      body: bytes,
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}
