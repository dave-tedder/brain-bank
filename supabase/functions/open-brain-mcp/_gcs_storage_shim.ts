// GCS Storage shim replacing Supabase Storage API for GCP Cloud Run execution.
// Targets file: supabase/functions/open-brain-mcp/_gcs_storage_shim.ts
//
// This module provides a drop-in replacement for the Supabase Client storage API:
//   supabase.storage.from('deliverables').upload(...)
//   supabase.storage.from('deliverables').download(...)
//   supabase.storage.from('deliverables').list(...)
//
// It transparently forwards these calls to Google Cloud Storage (GCS).
// When running locally outside of GCP, it falls back to local file storage under
// the `./gcp_local_storage/` directory for developer convenience.

const GCS_BUCKET = Deno.env.get("GCS_BUCKET_NAME") || "deliverables";

async function getGcsAccessToken(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000); // 1s timeout for metadata server check
    const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-account/default/token";
    const resp = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token;
  } catch {
    // Local / development fallback
    return Deno.env.get("GCS_ACCESS_TOKEN") || null;
  }
}

export function getGcsStorageShim() {
  return {
    from: (bucketName: string) => {
      const bucket = bucketName || GCS_BUCKET;
      return {
        upload: async (
          path: string,
          blob: Blob,
          options?: { contentType?: string; upsert?: boolean },
        ) => {
          try {
            const token = await getGcsAccessToken();
            const upsert = options?.upsert ?? false;
            const contentType = options?.contentType ?? "text/plain";

            if (!token) {
              // Local mock file write
              const localPath = `./gcp_local_storage/${bucket}/${path}`;
              const dir = localPath.substring(0, localPath.lastIndexOf("/"));
              
              if (!upsert) {
                try {
                  await Deno.stat(localPath);
                  return { data: null, error: new Error("Object already exists (local check)") };
                } catch {
                  // File does not exist, safe to proceed
                }
              }

              await Deno.mkdir(dir, { recursive: true });
              const content = await blob.text();
              await Deno.writeTextFile(localPath, content);
              return { data: { path }, error: null };
            }

            // GCS JSON API Media Upload
            const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(path)}`;
            const headers: Record<string, string> = {
              "Authorization": `Bearer ${token}`,
              "Content-Type": contentType,
            };

            // If upsert is false, use GCS If-Generation-Match header to prevent overwrite.
            // Generation 0 matches if there is no existing object.
            if (!upsert) {
              headers["If-Generation-Match"] = "0";
            }

            const resp = await fetch(uploadUrl, {
              method: "POST",
              headers,
              body: blob,
            });

            if (!resp.ok) {
              const errText = await resp.text();
              // If precondition failed (412), object already exists
              if (resp.status === 412) {
                return { data: null, error: new Error("Object already exists (GCS check)") };
              }
              return { data: null, error: new Error(`GCS upload failed: ${errText}`) };
            }

            return { data: { path }, error: null };
          } catch (err: unknown) {
            return { data: null, error: err as Error };
          }
        },

        download: async (path: string) => {
          try {
            const token = await getGcsAccessToken();

            if (!token) {
              // Local mock file read
              const localPath = `./gcp_local_storage/${bucket}/${path}`;
              const text = await Deno.readTextFile(localPath);
              return { data: new Blob([text]), error: null };
            }

            // GCS JSON API Get Object Media
            const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
            const resp = await fetch(downloadUrl, {
              headers: { "Authorization": `Bearer ${token}` },
            });

            if (!resp.ok) {
              return { data: null, error: new Error(`GCS download failed: ${resp.statusText}`) };
            }

            const blob = await resp.blob();
            return { data: blob, error: null };
          } catch (err: unknown) {
            return { data: null, error: err as Error };
          }
        },

        list: async (folder: string = "", options?: { limit?: number }) => {
          try {
            const token = await getGcsAccessToken();

            if (!token) {
              // Local mock list
              const localDir = `./gcp_local_storage/${bucket}/${folder}`;
              const entries: any[] = [];
              try {
                for await (const entry of Deno.readDir(localDir)) {
                  entries.push({
                    name: entry.name,
                    id: entry.isDirectory ? null : entry.name,
                    updated_at: new Date().toISOString(),
                    metadata: entry.isFile ? { size: 1000 } : null,
                  });
                }
              } catch {
                // Ignore missing directory error and return empty list
              }
              return { data: entries, error: null };
            }

            let prefix = folder ? folder.replace(/\/+$/, "") + "/" : "";
            if (prefix === "/") prefix = "";

            const limit = options?.limit ?? 500;
            const listUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}&delimiter=/&maxResults=${limit}`;
            const resp = await fetch(listUrl, {
              headers: { "Authorization": `Bearer ${token}` },
            });

            if (!resp.ok) {
              return { data: null, error: new Error(`GCS list failed: ${resp.statusText}`) };
            }

            const json = await resp.json();
            const entries: any[] = [];

            // 1. Folders (GCS common prefixes)
            for (const pref of json.prefixes || []) {
              const parts = pref.replace(/\/+$/, "").split("/");
              const name = parts[parts.length - 1];
              entries.push({
                name,
                id: null,
                updated_at: null,
                metadata: null,
              });
            }

            // 2. Objects (GCS items)
            for (const item of json.items || []) {
              if (item.name === prefix) continue; // skip the prefix search folder itself
              const name = prefix ? item.name.substring(prefix.length) : item.name;
              if (name.includes("/")) continue; // skip nested files deeper in prefix folders

              entries.push({
                name,
                id: item.id,
                updated_at: item.updated,
                metadata: { size: parseInt(item.size || "0", 10) },
              });
            }

            return { data: entries, error: null };
          } catch (err: unknown) {
            return { data: null, error: err as Error };
          }
        },
      };
    },
  };
}
