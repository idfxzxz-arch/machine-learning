# AlphaCodes AI

Chat AI lokal untuk AlphaCodes. Frontend memakai React + Vite, backend Node menjadi proxy aman ke endpoint OpenAI-compatible.

## Jalankan

```bash
npm install
npm start
```

Buka `http://127.0.0.1:3000`.

Dari perangkat lain di jaringan yang sama, buka IP komputer yang menjalankan app chat, misalnya `http://192.168.1.12:3000`.

## Development

Jalankan backend:

```bash
npm run server
```

Jalankan frontend Vite di terminal lain:

```bash
npm run dev
```

Frontend dev berjalan di `http://127.0.0.1:5173` dan proxy `/api` ke backend `http://127.0.0.1:3000`.

## Konfigurasi

Nilai koneksi ada di `.env`.

```env
PORT=3000
HOST=0.0.0.0
OPENAI_BASE_URL=http://100.70.61.19:20128/v1
OPENAI_API_KEY=isi_api_key_di_sini
DEFAULT_MODEL=cx/gpt-5.5
ALLOWED_MODELS=
AI_MAX_TOKENS=2048
ALLOWED_ORIGINS=
VITE_API_BASE_URL=
```

`PORT` opsional. Jika server/hosting memberi environment variable `PORT`, app akan mengikuti nilai itu. Jika tidak ada, app otomatis fallback ke `3000`.
Kosongkan `ALLOWED_MODELS` untuk menampilkan semua model chat publik dari endpoint. Isi dengan daftar model dipisah koma jika ingin membatasi pilihan.
`ALLOWED_ORIGINS` boleh dikosongkan untuk localhost/LAN. Untuk domain publik, isi dengan origin lengkap, misalnya `https://ai.alphacodes.id`.
`VITE_API_BASE_URL` boleh dikosongkan jika frontend dan backend berada di domain yang sama. Jika frontend static berada di domain berbeda, isi dengan URL backend, lalu build ulang.

Jika engine AI berjalan di mesin yang sama dengan app ini, gunakan `http://127.0.0.1:20128/v1`.
Jika engine AI berada di mesin lain, baru gunakan IP LAN/Tailscale mesin AI, misalnya `http://100.70.61.19:20128/v1`.

## Deploy Domain

Domain harus diarahkan ke server Node app ini, bukan hanya ke folder `dist`. Jika `/api/config` mengembalikan HTML `<!doctype html>`, berarti reverse proxy belum mengarah ke backend.

Contoh Nginx:

```nginx
server {
  server_name agents.idkxz.my.id;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Setelah deploy, tes:

```bash
curl https://agents.idkxz.my.id/api/config
curl https://agents.idkxz.my.id/api/models
```

Keduanya harus mengembalikan JSON, bukan HTML.

Fitur utama:

- Frontend React + Vite
- Chat streaming dengan riwayat percakapan di browser
- Tampilan branded untuk AlphaCodes
- Model chat dibatasi dari server
- Stop, regenerate, copy pesan/kode, export Markdown
- Tema terang/gelap dan layout responsif
- Guardrail server-side untuk menolak permintaan yang mengarah ke file internal, kredensial, endpoint lokal, atau eksekusi perintah server
