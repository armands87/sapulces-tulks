# Sapulces tulks

Telefona tīmekļa lietotne (PWA): klausās angļu runu caur mikrofonu un uzreiz rāda latviešu tulkojumu lieliem burtiem. Paredzēta Chrome pārlūkam Android telefonā, kas sapulces laikā stāv uz galda blakus datoram un uz kuru skatās ar acs kaktiņu.

## v3 (22.11): subtitru skats un mazāka aizture

### Problēma

v2 rādīja tulkojumu pa teikumiem. Teksts parādījās tikai pēc teikuma beigām, ātrajā režīmā provizoriskais tulkojums tika pārrakstīts (vārdi lēca un mainījās), un acs nezināja, kur ir "tagad". Aizture līdz stabilam tekstam bija 4 līdz 6 s.

### Jaunais skats "Subtitri" (noklusējums, poga `CC`)

Principi, pēc kuriem tas veidots (TV subtitri, telepromteris, tiešraides titri konferencēs):

1. **Fiksēts logs ar 5 rindām ekrāna vidū.** Jaunākā rinda vienmēr ir tajā pašā vietā, tāpēc acs, uzmetot skatienu, uzreiz zina, kur skatīties.
2. **Teksts tikai pieaug beigās, nekas netiek pārrakstīts.** Runa tiek tulkota īsās frāzēs (~4 vārdi vai līdz pauzei). Katra frāze tiek pievienota beigās un pēc tam nemainās. Tā kā rindu pārnešana notiek tikai pēdējā rindā, augšējās rindas nekad nepārkārtojas.
3. **Jaunākā frāze ir izcelta** ar mierīgu dzintara krāsu (baltajā fonā dzeltens marķieris), aiz tās mirgo kursors. Kad atnāk nākamā frāze, iepriekšējā lēni (0,9 s) kļūst parastā krāsā. Acs redz, kur ir "tagad", un var vienā skatienā izlasīt arī iepriekšējo rindu.
4. **Vecākās rindas aizslīd uz augšu un izbalē** (maska augšējās 1,5 rindās). Jauna rinda ieslīd vienmērīgi (260 ms), bez lēciena.
5. **Jauna runas daļa pēc garākas pauzes (>2,5 s) sākas jaunā rindā** ar nelielu atstarpi, tāpat kā rindkopa.
6. **Kontrasts un lasāmība**: tumšajā fonā gandrīz balts (#f2f2f2, mazāk žilbina nekā tīri balts), treknraksts, rindstarpa 1,32, 40 px pēc noklusējuma (A−/A+ maina).
7. **Angļu oriģināls** tikai kā viena bāla rindiņa zem loga (poga `EN`, pēc noklusējuma izslēgts).
8. Statuss un lielā poga ir apakšā, augšējā josla ir tikai pogas un darba laikā ir bāla.

Ekrānuzņēmumi (390x844, ar reālistisku tekstu, viltots mikrofons un OpenAI): `screens/live-dark.png`, `screens/live-light.png`, `screens/live-dark-en.png`. Tos nepublicē.

Iepriekšējie režīmi paliek kā alternatīvas (poga `CC` → `1` → `≡`):
- `1` **Tikai pašreizējais teikums**: liels pašreizējais teikums, iepriekšējais mazs virs tā.
- `≡` **Visa vēsture**: pašreizējais teikums dzeltenā.

### Aizture

Ceļš: runa → Google runas atpazīšana Chrome (starprezultāti) → frāžu dalītājs → OpenAI (straumēts) → ekrāns.

Kas mainīts:
- **Frāzes, nevis teikumi.** Dalītājs (`core.js` → `planChunk`) nosūta tulkošanai frāzi, tiklīdz ir 4 stabili vārdi (pēdējo vārdu patur, jo atpazīšana to vēl var labot) vai iestājas 0,6 s pauze. Ja iespējams, griež pirms saikļa (and, but, because, which...), lai frāze būtu dabiska.
- **Paralēli pieprasījumi ar secību.** Katrai frāzei vieta ekrānā tiek rezervēta brīdī, kad tā nosūtīta, tāpēc atbildes var atnākt jebkurā secībā, bet ekrānā tās vienmēr ir pareizā secībā.
- **Straumēšana**: vārdi parādās, tiklīdz modelis tos sāk rakstīt.
- **Mazs uzdevums**: sistēmas uzdevums ~120 žetoni, kontekstam tikai iepriekšējo frāžu pēdējās ~160 rakstzīmes angliski un latviski (lai tulkojums turpinās dabiski un neatkārtojas). Izvade līdz 120 žetoniem.
- **Silts savienojums**: `preconnect` uz api.openai.com un bezmaksas pieprasījums (`GET /v1/models/<modelis>`) startā un ik pēc 40 s dīkstāves. Auksts TLS savienojums mobilajā tīklā pievieno 200 līdz 600 ms.
- **Ātruma tests** (⚙): izmēra laiku līdz pirmajam tulkotajam vārdam modeļiem gpt-4.1-nano, gpt-4.1-mini, gpt-4o-mini, gpt-5-nano tieši lietotāja telefonā un tīklā un parāda tulkojumu, lai var salīdzināt arī kvalitāti.
- **Mērījums ekrānā**: statusā "Klausās · 1,4 s" (mediāna pēdējām 10 frāzēm). ⚙ → Diagnostika rāda sadalījumu: gaidīšana uz frāzi un OpenAI līdz pirmajam vārdam.

Mērījumi imitācijā (viltots mikrofons 2,5 vārdi/s, viltots OpenAI ar 450 ms līdz pirmajam vārdam, kas ir tipiski gpt-4.1-mini; 3 teikumi, 14 līdz 19 vārdi). Laiks no brīža, kad vārds atpazīts, līdz tā tulkojums parādās ekrānā, mediāna:

| Tulkošanas solis | Aizture | No tā gaida frāzi | OpenAI |
|---|---|---|---|
| Īsas frāzes (noklusējums) | **1,45 s** | 1,0 s | 0,45 s |
| Garākas frāzes | 2,46 s | 2,0 s | 0,45 s |
| Pa teikumiem (kā v2 stabilais teksts) | 4,16 s | 3,7 s | 0,45 s |

Klāt nāk Google runas atpazīšana (aptuveni 0,3 līdz 0,7 s, pārlūkā nav izmērāma). Tātad reāli: **v2 ap 4,5 līdz 5 s līdz stabilam tekstam, v3 ap 1,8 līdz 2,2 s**, un teksts vairs nelēkā. Īstos skaitļus rādīs telefons (statuss un Diagnostika).

Cena par ātrumu: īsās frāzēs tulkojums ir nedaudz "simultānā tulka" stilā (vārdu secība seko angļu valodai). Ja valoda svarīgāka par ātrumu, ⚙ → Tulkošanas solis → Garākas frāzes.

### Modelis

Noklusējums paliek **gpt-4.1-mini**: bez "domāšanas" soļa (zema aizture), labākā latviešu valoda starp lētajiem. `gpt-4.1-nano` parasti ir par 50 līdz 150 ms ātrāks un 4x lētāks, bet latviešu valodā vājāks. `gpt-5-nano` / `gpt-5-mini` ir "domājošie" modeļi; pat ar `reasoning_effort: minimal` tie parasti atbild lēnāk. Galīgo izvēli labāk izdarīt ar **Ātruma testu** telefonā, nevis pēc pieņēmumiem.

### OpenAI Realtime API: izvērtēts, nav ieviests

- **`gpt-realtime-translate`** (speciāls tiešraides tulkošanas modelis, $0,034/min = ~$2/h) **neder: tas tulko tikai uz 13 valodām, latviešu valodas starp tām nav** (latviešu ir tikai kā ievades valoda).
- **`gpt-realtime-mini`** (runa iekšā, teksts ārā): audio ievade ~$10 par 1M žetonu, ~600 žetoni minūtē, tātad ~$0,36/h tikai ievadei, plus izvade un sesijas konteksta atkārtota apstrāde: kopā ap **$0,5 līdz 1,5/h** (pilnais `gpt-realtime` 3x dārgāks). Aizture: modelis atbild pēc runas pauzes (VAD). Nepārtrauktā sapulces runā tas nozīmē gaidīt pauzi, tātad līdzīgi kā "pa teikumiem", ja vien audio netiek piespiedu kārtā sadalīts ik pēc ~2 s; tad tas būtu līdzīgs mūsu frāžu pieejai, bet 5 līdz 10 reizes dārgāks. Ieguvums būtu tikai Google atpazīšanas soļa izlaišana (~0,3 līdz 0,5 s).
- **Pārlūkā ar paša atslēgu**: tehniski iespējams (pārlūks ar lietotāja atslēgu izveido īslaicīgu klienta atslēgu un pieslēdzas ar WebRTC), drošības ziņā tas pats kā tagad. Bet tas ir krietni sarežģītāk, un šeit to nevar pārbaudīt.
- **Secinājums**: Chrome runas atpazīšana + frāzes + straumēts Chat Completions ir ātrāks vai līdzvērtīgs un 5 līdz 10 reizes lētāks. Realtime pieeju vērts izmēģināt tikai tad, ja Google atpazīšana no skaļruņa izrādās neprecīza.

### Izmaksas stundā (aplēse, cenas jāpārbauda)

~7800 vārdi stundā, īsās frāzes ~1700 pieprasījumi, katrā ~170 ievades un ~15 izvades žetoni. Starptulkojumi (v2 "ātrais režīms") vairs netiek sūtīti, tāpēc ir lētāk nekā v2.

| Modelis | Cena (1M žetonu ievade / izvade) | v3 | v2 ātrajā režīmā |
|---|---|---|---|
| gpt-4.1-mini (noklusējums) | ~$0,40 / $1,60 | **~$0,16/h** | ~$0,27/h |
| gpt-4o-mini | ~$0,15 / $0,60 | ~$0,06/h | ~$0,10/h |
| gpt-4.1-nano | ~$0,10 / $0,40 | ~$0,04/h | |
| Realtime (gpt-realtime-mini) | audio | ~$0,5 līdz 1,5/h | |

Runas atpazīšana (Google, caur Chrome) ir bez maksas.

## Kas ir iekšā

| Fails | Nozīme |
|---|---|
| `index.html`, `style.css` | Ekrāns: subtitru logs, A−/A+, režīms (CC / 1 / ≡), EN, fons, ⚙; apakšā statuss un Sākt/Apturēt |
| `app.js` | Runas atpazīšana ar automātisku restartu un sargsuni, frāžu dalītājs, paralēla straumēta tulkošana, kļūdu josla, aiztures mērījums, ātruma tests, Wake Lock, stenogramma |
| `core.js` | Loģika bez DOM: frāžu dalītājs, uzdevums, kļūdu klasifikācija, sargsuņa lēmumi, straumes parsētājs |
| `sw.js`, `manifest.json`, `icons/` | PWA (pievienot sākuma ekrānam, pilnekrāns). Kešatmiņas versija `tulks-v3` |
| `test/run-tests.js` | 66 loģikas testi, bez interneta un atslēgas |
| `test/mocks.js` | Viltots mikrofons (arī `MOCK.speak` ar runas ātrumu) un viltots OpenAI (labi, iekāras, apstājas, 401, kredīts, 429; aizture `MOCK.ttft`) |
| `test/demo.js` | Scenārijs ekrānuzņēmumiem (`#demo-dark`, `#demo-light`, `#demo-dark-en`) |
| `test/make-icons.rb` | PNG ikonas |
| `screens/` | Ekrānuzņēmumi lietotājam, nepublicēt |

Testi uz šī Mac (node nav, izmanto JavaScriptCore):

```
cd translator-app
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test/run-tests.js
```

Pārlūka tests: izveido lokālu kopiju `index.html` ar `<script src="test/mocks.js"></script>` (un ekrānuzņēmumiem `test/demo.js`) pirms `core.js`, piemēram `test-harness.html`, palaid `ruby -run -e httpd . -p 8765`. Ekrānuzņēmumi 390x844: lapa ar `<iframe>` 390x844, kas ielādē `test-harness.html?notransition#demo-dark`, un headless Chrome ar `--window-size=390,844 --force-device-scale-factor=2 --virtual-time-budget=25000 --screenshot`. Šīs lapas nepublicē.

## Kā tas strādā

1. **Runas atpazīšana**: Chrome `webkitSpeechRecognition`, `en-US`, `continuous`, `interimResults`. Android Chrome pārtrauc klausīties pēc klusuma vai ~1 min, tāpēc lietotne restartē (250 ms, pie atkārtotām kļūdām līdz 4 s). Sargsuns ik pa 3 s: ja nekas nestrādā, palaiž; ja 30 s nav neviena notikuma vai `start()`/kļūdai neseko atbilde, izmet veco atpazinēju un izveido jaunu. Android dublikātus filtrē `newFinalPart`.
2. **Frāzes un tulkošana**: skatīt v3 sadaļu augstāk. Neizdevusies frāze tiek atkārtota līdz 2 reizēm (noildze 10 s, straumes klusums 5 s); ja tā tomēr neizdodas, ekrānā paliek angļu frāze pelēkā slīprakstā, lai jēga nepazūd.
3. **Statuss un kļūdas**: statuss apakšā (Klausās · aizture, Ieslēdz mikrofonu…, Restartē…, Fonā, Apturēts), punkts mirgo, kad mikrofons dzird skaņu. Kļūdu josla zem augšējās joslas: dzeltena (īslaicīga, mēģina vēlreiz) vai sarkana (nederīga atslēga, beidzies kredīts, modelis nav pieejams, nav mikrofona atļaujas).
4. **Diagnostika** (⚙): aiztures sadalījums un pēdējie 80 notikumi.

## Apstāšanās kļūda (v2, 22.11)

v1 cēloņi: tulkošanas pieprasījumiem nebija noildzes (iekārusies atbilde bloķēja turpmākos), iekārusies atpazīšana netika restartēta (gaidīja `onend`, kas nepienāca), `not-allowed` apturēja visu, kļūdas nebija redzamas, Wake Lock netika atjaunots. Visi labojumi ir spēkā arī v3.

## OpenAI atslēga un drošība

- Atslēga **nav** kodā un nav repozitorijā. To ielīmē ⚙, tā glabājas tikai telefona `localStorage` un tiek sūtīta tikai uz `api.openai.com`.
- Ieteikums: atsevišķa projekta atslēga ar mēneša tēriņu limitu (piemēram $5).

## Bezmaksas variants

- **Chrome iebūvētais tulkotājs** ir ⚙ kā otrs variants (zemāka kvalitāte, bez konteksta). Android Chrome tas visticamāk nav pieejams; lietotne to pārbauda.
- **MyMemory** nav pievienots: anonīmais limits ~5000 rakstzīmes dienā, stundas sapulcei vajag 40 000 līdz 50 000.

## Skaņa no datora skaļruņiem telefona mikrofonā

- Atbalss nav problēma (telefons neko neatskaņo). Svarīga ir skaidra, pietiekami skaļa skaņa.
- Telefons 20 līdz 50 cm no skaļruņa, apakšējā mala pret skaļruni, skaļums 60 līdz 80 %, bez telpiskās skaņas efektiem. Ar austiņām telefons neko nedzirdēs.
- Paša runātais arī tiks tulkots. Restarta signālu Android var noslāpēt, izslēdzot multivides/paziņojumu skaņu.
- Alternatīva: Meet un Teams iebūvētie (tulkotie) subtitri, ja tie atbalsta latviešu valodu.

## Izvietošana GitHub Pages

Repozitorijs `armands87/sapulces-tulks`, adrese `https://armands87.github.io/sapulces-tulks/`. Augšupielādi veic koordinators pēc lietotāja apstiprinājuma (uz šī Mac nav `git`, tiek izmantots `gh api` vai tīmekļa saskarne).

Publicējamie faili: `index.html`, `style.css`, `core.js`, `app.js`, `sw.js`, `manifest.json`, `icons/`, `README.md`. `test/` var publicēt vai nepublicēt. **Nepublicē** `screens/` un nevienu lapu, kas ielādē `test/mocks.js`.

Pēc atjaunināšanas telefonā lietotni aizver un atver vēlreiz (service worker: "vispirms tīkls", kešatmiņa `tulks-v3`). v3 vienreiz pārslēdz esošos iestatījumus uz subtitru režīmu; atslēga saglabājas.

## Uzstādīšana telefonā

1. Chrome atver `https://armands87.github.io/sapulces-tulks/`, izvēlne ⋮ → **Pievienot sākuma ekrānam**.
2. ⚙ → ielīmē OpenAI atslēgu → **Pārbaudīt** → **Ātruma tests** → **Gatavs**.
3. **Sākt** → atļauj mikrofonu.

## Zināmie ierobežojumi

- Testēts: 66 loģikas testi, pārlūka scenāriji ar viltotu mikrofonu un OpenAI (subtitru plūsma, frāžu secība, aizture trim soļiem, iekārusies atbilde un atgūšanās, 401 ar angļu teksta rezervi, visi trīs režīmi, abi foni). **Uz īsta Android telefona nav pārbaudīts**: kā Android Chrome starprezultāti mainās (cik bieži tiek laboti jau nosūtītie vārdi), īstā aizture un frāžu tulkojumu valodas kvalitāte.
- Ja atpazīšana pārlabo vārdu, kas jau nosūtīts tulkošanai, ekrānā paliek pirmā versija (teksts apzināti netiek pārrakstīts).
- Web Speech API sūta skaņu Google, teksts iet uz OpenAI: jāņem vērā konfidenciālās sapulcēs.
