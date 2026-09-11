# Vercel'ga xavfsiz joylash

Loyiha tuzilishi:

```
index.html      – sayt (kalit YO'Q; /api/grade ga faqat matn yuboradi)
api/grade.js    – serverless proxy: kalit, prompt, model, limitlar shu yerda
vercel.json     – funksiya uchun 30 s vaqt
.env.example    – kerakli muhit o'zgaruvchilari ro'yxati (namuna)
.vercelignore   – deploy'ga chiqmaydigan fayllar (eski variantlar)
```

## 1. Kalitlarni tozalang

- `ielts_gemeni.html` va `ielts_mock_openai.html` ichida haqiqiy kalitlar yozilgan. Ularni
  fayldan o'chiring (yoki fayllarni butunlay olib tashlang) — `git add .` qilsangiz GitHub'ga
  tushib qoladi.
- OpenAI kalitingiz faylga yozilib, ulashilgan bo'lsa — **yangi kalit yarating** va eskisini
  o'chiring: https://platform.openai.com/api-keys

## 2. GitHub'ga push qiling

```bash
git add index.html api/grade.js vercel.json .gitignore .vercelignore .env.example DEPLOY.md
git commit -m "Move OpenAI key to server-side proxy"
git push
```

## 3. Vercel'da loyiha oching

1. https://vercel.com → **Add New… → Project** → `najmiddin3003/ielts-mock` repo'sini import qiling.
2. Framework Preset: **Other**. Build sozlamalariga tegmang. **Deploy**.
3. Project → **Settings → Environment Variables**:
   - `OPENAI_API_KEY` = `sk-...` (Production va Preview uchun belgilang)
   - ixtiyoriy: `OPENAI_MODEL`, `RATE_LIMIT_PER_HOUR` (default 20), `ALLOWED_ORIGINS`
4. **Deployments → ⋯ → Redeploy** (muhit o'zgaruvchisi faqat yangi deploy'da kuchga kiradi).

## 4. OpenAI'da xarajat chegarasini qo'ying

https://platform.openai.com/settings/organization/limits → **Monthly budget** (masalan, $10)
va **Email alert**. Bu — hamma narsa buzilgan taqdirda ham zararni chegaralaydigan oxirgi himoya.

## 5. Tekshiring

Saytni oching → ro'yxatdan o'ting → Writing → matn yozib **AI orqali baholash**.
Xato chiqsa, sabab: Vercel → Project → **Logs** (brauzerga faqat umumiy xabar boradi, to'liq
matn logda).

## Himoya qatlamlari (api/grade.js)

| Qatlam | Nima qiladi |
|---|---|
| Kalit serverda | HTML/JS/Network'da kalit umuman yo'q |
| Faqat IELTS | Brauzer promptni emas, faqat essay matnini yuboradi; prompt/model/max_tokens serverda |
| Uzunlik limiti | 12 000 belgidan uzun so'rov rad etiladi (413) |
| Rate limit | Bir IP — soatiga 20 baholash (429). Doimiy hisoblagich uchun Upstash Redis ulash mumkin (bepul) |
| Origin tekshiruvi | Faqat o'z domeningizdan kelgan so'rovlar (403). Soxtalash mumkin, lekin oddiy skriptlarni to'xtatadi |
| Budjet limiti | OpenAI dashboard'da oylik chegara |

## Lokal test (ixtiyoriy)

```bash
npx vercel link
npx vercel env pull .env.local
npx vercel dev
```

`.env*` fayllari `.gitignore`da — git'ga tushmaydi.
