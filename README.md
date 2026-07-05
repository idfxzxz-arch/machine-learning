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
OPENAI_BASE_URL=http://192.168.1.13:20128/v1
OPENAI_API_KEY=isi_api_key_di_sini
DEFAULT_MODEL=cx/gpt-5.5
ALLOWED_MODELS=cx/gpt-5.5,cx/gpt-5.4,cx/gpt-5.4-mini
AI_MAX_TOKENS=2048
```

Fitur utama:

- Frontend React + Vite
- Chat streaming dengan riwayat percakapan di browser
- Tampilan branded untuk AlphaCodes
- Model chat dibatasi dari server
- Stop, regenerate, copy pesan/kode, export Markdown
- Tema terang/gelap dan layout responsif
- Guardrail server-side untuk menolak permintaan yang mengarah ke file internal, kredensial, endpoint lokal, atau eksekusi perintah server

# machine-learning
