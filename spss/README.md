# SPSS Monitorizarea proiectării

Ediția publică demonstrativă 1.0.0 include un catalog sintetic, migrațiile SQLite și interfața în limba română. La prima pornire, administratorul își creează contul local.

## Pornirea distribuției Windows

Instalați Node.js 24 LTS x64, minimum 24.12. Extrageți arhiva publică și executați din directorul ei în PowerShell.

```powershell
Copy-Item .env.example .env
node --env-file=.env scripts/migrate.mjs
node --env-file=.env scripts/admin.mjs
node --env-file=.env dist/server/server/main.js
```

Deschideți [http://127.0.0.1:3101/](http://127.0.0.1:3101/). Baza demonstrativă este creată în `var/spss.sqlite`, iar `/healthz` verifică disponibilitatea aplicației și a bazei. Configurația HTTP din exemplu este pentru acces local.

## Construirea din codul sursă

Din directorul `spss`, executați comenzile de mai jos, apoi urmați pașii de pornire de mai sus.

```powershell
npm ci
npm run typecheck
npm run build
npm test
```
