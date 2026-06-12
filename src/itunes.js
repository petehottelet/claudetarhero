// iTunes Search API client (via /api/proxy to dodge CORS).
// Every track returned includes a free ~30 second audio preview.

export async function searchSongs(term) {
  const r = await fetch(`/api/proxy?type=search&term=${encodeURIComponent(term)}`);
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  const data = await r.json();
  return (data.results || [])
    .filter((t) => t.previewUrl)
    .map((t) => ({
      id: t.trackId,
      title: t.trackName,
      artist: t.artistName,
      album: t.collectionName,
      artwork: (t.artworkUrl100 || '').replace('100x100', '200x200'),
      previewUrl: t.previewUrl,
    }));
}

export async function fetchPreview(previewUrl) {
  const r = await fetch(`/api/proxy?type=audio&url=${encodeURIComponent(previewUrl)}`);
  if (!r.ok) throw new Error(`preview download failed (${r.status})`);
  return await r.arrayBuffer();
}
