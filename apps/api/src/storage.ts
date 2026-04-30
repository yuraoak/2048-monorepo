import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// S3-compatible blob storage. On Railway this is the managed Object Storage
// service (S3-compatible endpoint). The same code works against AWS S3 or
// any other compatible provider that uses virtual-hosted-style URLs.
//
// We assemble the public URL ourselves as `https://<bucket>.<host>/<key>`
// rather than taking a separate public-base-url env var: that's exactly
// the virtual-hosted layout Railway/R2/AWS use, so we'd just be asking
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
    // Region is meaningless for non-AWS S3-compatible providers (Railway,
    // R2, Minio); they accept anything. Hardcode "auto" so users don't
    // have to set an env var that does nothing.
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
    // Virtual-hosted style — bucket goes into the host part of the URL
    // (e.g. https://my-bucket.t3.storageapi.dev/key.png). Required by
    // Railway's bucket UI ("Use virtual-hosted-style URLs.") and matches
    // AWS/R2 default behavior.
    forcePathStyle: false,
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

// Fetches an object using the same credentials we uploaded with. Tigris
// (Railway's storage backend) doesn't expose any public-read toggle and
// returns 501 NotImplemented on PutBucketPolicy, so direct anonymous GETs
// to the bucket URL aren't possible. We stream objects through the API to
// keep share images publicly scrapable by Farcaster.
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
