# Staging MCP (Pilihan B)

Server MCP lokal yang menerima konten file besar **per potongan**, menyimpannya di disk,
lalu push ke GitHub sekaligus. Memutus ketergantungan pada satu JSON `mcp_call` raksasa.

## Aktifkan

1. Set token GitHub di environment (classic token dengan scope `repo`):

   ```
   set GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
   ```

2. Tambahkan entri ke `servers.json`:

   ```json
   {
     "name": "staging",
     "command": ["python", "server/examples/stage_mcp_server.py"],
     "port": 8081,
     "env": { "GITHUB_TOKEN": "ghp_xxxxxxxxxxxxxxxx" }
   }
   ```

   (Atau pakai variabel environment mesin, tanpa `env` di JSON.)

3. Restart bridge:

   ```
   python server/mcp_ws_bridge.py --config servers.json --restart
   ```

## Tool

| Tool | Fungsi |
|------|--------|
| `stage_file` | Kirim satu potongan (<=150 baris). Panggilan pertama tanpa `stage_id`, berikutnya wajib pakai `stage_id` yang dikembalikan. |
| `flush_staged_file` | Gabungkan semua potongan lalu commit ke GitHub. Butuh `GITHUB_TOKEN`. |
| `abort_staged_file` | Batalkan dan hapus potongan. |

## Alur yang diharapkan dari model

1. `stage_file(path, chunk_index=0, total_chunks=N, content=...)` -> dapat `stage_id`.
2. `stage_file(stage_id, chunk_index=1..N-1, content=...)` berurutan.
3. `flush_staged_file(stage_id, owner, repo, branch, message, sha?)`.

Jika file sudah ada, ambil `sha` lewat `get_file_contents` sebelum flush.

## Keamanan

- Potongan disimpan di `%USERPROFILE%/.wmb/staging/<stage_id>/` (bisa diubah lewat `WMB_STAGE_DIR`).
- `stage_store.sweep()` menghapus stage yang tidak tersentuh > 6 jam.
- Setelah `flush` atau `abort`, direktori stage dihapus.
