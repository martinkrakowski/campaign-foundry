import { objectStore, objectStoreSettings } from "../lib/config.js";

/**
 * Boot-time validation of the object-store configuration (PT-4d), the
 * `auth-boot-guard.ts` precedent for a SECOND store's variables.
 *
 * `objectStoreSettings()` under `s3` is where the six `S3_*` variables are
 * checked for presence and shape, and it reads no socket: a missing variable, a
 * relative endpoint, a `user:pass@host` endpoint or a non-postgres
 * `STORE_BACKEND` all fail here, at boot, where the operator can see which
 * variable to fix — rather than on the first read of a brief's logo, as a 500
 * with a message about a credential.
 *
 * **What this does NOT catch, said plainly:** a bucket NAME that is wrong. Every
 * 404 maps to `undefined` in `S3ObjectStore.get` — `NoSuchBucket` included, since
 * it is an S3 answer rather than a transport failure — so a misspelled
 * `S3_BUCKET` passes this guard and every input read then answers ENOENT: logos
 * and scenes missing, and the run failing on the ref rather than on the
 * deployment. Catching it needs a network call, and a boot check that reaches the
 * network fails a rolling restart for a bucket that is still starting.
 */
export default defineNitroPlugin(() => {
  if (objectStore() !== "s3") return;
  objectStoreSettings();
});
