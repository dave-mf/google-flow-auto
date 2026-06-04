# Google Flow Prompt Auto

Chrome extension untuk menjalankan daftar prompt dari file `.txt` di Google Flow: upload prompt, isi editor Flow, submit generate, tunggu hasil, lalu coba download hasil terbaru. Download sekarang memakai Chrome Downloads API sebagai jalur utama, lalu fallback ke menu titik tiga jika URL/media hasil tidak bisa diambil langsung.

## Cara Pakai

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode**.
3. Klik **Load unpacked**.
4. Pilih folder:
   `/Users/davemf/Documents/Chrome Project/google-flow-prompt-auto`
5. Setelah update file extension, klik tombol **Reload** di kartu extension.
6. Buka atau refresh halaman Google Flow project Anda.
7. Klik icon extension, upload file `.txt`, atur timeout/delay bila perlu, lalu klik **Start**.

Chrome dapat menampilkan peringatan bahwa extension memakai permission **debugger**, **tabs**, dan **downloads**. `debugger` dipakai agar klik generate dan fallback menu download dikirim sebagai input browser via CDP, karena klik DOM biasa tidak selalu diterima Google Flow. `tabs` dipakai untuk mengingat dan mencari tab Google Flow yang menjadi target automasi. `downloads` dipakai untuk menyimpan file hasil langsung lewat Chrome Downloads API saat URL/media hasil bisa dibaca.

## Format TXT

Format bernomor:

```txt
1. A modern sustainable office workspace...
2. A lush vertical garden wall...
```

Format baris biasa juga didukung:

```txt
A modern sustainable office workspace...
A lush vertical garden wall...
```

Baris kosong akan diabaikan.

## Pengaturan

Popup memakai UI minimalis modern dengan tema utama biru dan spacing konsisten antar panel. Upload file prompt memakai input file native langsung di popup.

- **Timeout hasil**: batas maksimal menunggu hasil baru muncul setelah submit generate. Default 30 detik.
- **Delay setelah hasil**: jeda setelah hasil terdeteksi dan download dicoba sebelum lanjut ke prompt berikutnya. Ini membantu mencegah proses download dan generate berikutnya saling tabrakan.

## Target Tab Tanpa Auto-Pindah

Saat **Start** diklik dari halaman Google Flow, extension menyimpan tab tersebut sebagai target. Setelah itu **Pause**, **Resume**, **Next**, dan **Stop** tetap dikirim ke tab Flow yang tersimpan.

Auto-pindah tab dimatikan. Extension tidak lagi mengaktifkan tab Flow atau memindahkan fokus window secara otomatis. Untuk hasil paling stabil, biarkan tab Flow aktif saat fase isi prompt, generate, dan download berjalan.

Jika tab Flow ditutup atau URL-nya berubah, automasi akan pause/error dengan pesan **Tab Google Flow tidak ditemukan. Buka halaman Flow lalu Resume.**

## Auto Download

Setelah hasil baru terdeteksi, extension akan mencoba:

1. Simpan daftar kartu yang sudah ada sebelum prompt disubmit.
2. Setelah hasil muncul, targetkan kartu baru yang tidak ada di daftar awal.
3. Cari media utama di kartu hasil terbaru (`img`, `video`, atau `canvas`).
4. Jika URL/media bisa dibaca, download langsung lewat **Chrome Downloads API** dengan nama file dari prompt dan timestamp.
5. Jika direct download gagal, fallback ke alur lama: hover kartu, klik tombol titik tiga, pilih **Download**, lalu pilih ukuran seperti **1K / Ukuran asli**.

Direct download lebih stabil saat Anda berada di tab lain karena tidak perlu membuka menu Google Flow. Namun fase isi prompt dan generate tetap lebih stabil jika tab Flow aktif, karena editor dan submit masih bergantung pada UI halaman.

Jika Chrome meminta izin multiple downloads untuk `labs.google`, pilih **Allow** agar batch download tidak tertahan. Setelah update extension, selalu klik **Reload** di `chrome://extensions` dan refresh tab Flow agar script terbaru aktif.

## Debug Console

Setelah extension di-reload dan halaman Flow di-refresh, beberapa helper tersedia di Console halaman:

```js
await window.__flowPromptAutoDebug.fillPrompt("A sustainable green office workspace")
await window.__flowPromptAutoDebug.clickGenerate()
await window.__flowPromptAutoDebug.autoDownloadResults()
await window.__flowPromptAutoDebug.downloadResultDirect()
await window.__flowPromptAutoDebug.debugDownloadCandidates()
```

## Catatan

Extension ini tidak bypass login, CAPTCHA, quota, policy/safety block, atau limit Google Flow. Jika hasil tidak terdeteksi dalam timeout, automasi akan pause dengan pesan error.
