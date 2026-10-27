import { httpJson } from './util.mjs';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// "ghcr.io/owner/repo" -> { host: "ghcr.io", name: "owner/repo" }
export function splitImage(image) {
  const idx = image.indexOf('/');
  if (idx < 1) throw new Error(`Image "${image}" must look like host/owner/repo`);
  return { host: image.slice(0, idx), name: image.slice(idx + 1) };
}

// Read-only OCI registry client: just enough to check that a tag or digest
// exists in GHCR and to learn the digest a tag points to.
export class Registry {
  constructor({ registryUrl = 'https://ghcr.io', user, token, fetchImpl = fetch }) {
    this.registryUrl = registryUrl.replace(/\/$/, '');
    this.user = user;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async pullToken(name) {
    const host = new URL(this.registryUrl).host;
    const headers = {};
    if (this.user && this.token) {
      headers.authorization = `Basic ${Buffer.from(`${this.user}:${this.token}`).toString('base64')}`;
    }
    const url = `${this.registryUrl}/token?service=${encodeURIComponent(host)}&scope=${encodeURIComponent(`repository:${name}:pull`)}`;
    const res = await httpJson(url, { headers, fetchImpl: this.fetchImpl });
    if (!res.ok || !res.data?.token) throw new Error(`Registry token request failed with HTTP ${res.status}`);
    return res.data.token;
  }

  // Returns { exists: false } or { exists: true, digest }.
  async manifest(name, reference) {
    const bearer = await this.pullToken(name);
    const res = await this.fetchImpl(`${this.registryUrl}/v2/${name}/manifests/${reference}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${bearer}`, accept: MANIFEST_TYPES },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return { exists: false };
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Registry denied access to ${name} (HTTP ${res.status}); is the package readable with this token?`);
    }
    if (!res.ok) throw new Error(`Registry HEAD ${name}:${reference} failed with HTTP ${res.status}`);
    const digest = res.headers.get('docker-content-digest');
    if (!digest) throw new Error(`Registry did not return a digest for ${name}:${reference}`);
    return { exists: true, digest };
  }
}

export const shaTag = (sha) => `sha-${sha}`;
