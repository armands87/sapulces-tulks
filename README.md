# Sapulces tulks

Telefona tīmekļa lietotne (PWA): klausās angļu runu caur mikrofonu un uzreiz rāda latviešu tulkojumu ļoti lieliem burtiem. Paredzēta Chrome pārlūkam Android telefonā, kas sapulces laikā stāv uz galda blakus datoram.

## Kas ir iekšā

| Fails | Nozīme |
|---|---|
| `index.html`, `style.css` | Ekrāns: melns fons ar baltiem burtiem (vai otrādi), liela poga Sākt/Apturēt, A−/A+ un slīdnis teksta izmēram, EN (angļu oriģināls zem tulkojuma), fona maiņa, pilnekrāns, ⚙ iestatījumi |
| `app.js` | Runas atpazīšana (Web Speech API, en-US, nepārtraukta, ar automātisku restartu), tulkošana, ekrāna nomodā turēšana (Wake Lock), stenogrammas saglabāšana |
| `core.js` | Loģika bez DOM (pieprasījuma uzbūve, straumes parsētājs, Android dublikātu filtrs, restarta aizture), testējama atsevišķi |
| `sw.js`, `manifest.json`, `icons/` | PWA: var pievienot sākuma ekrānam, atveras pilnekrānā |
| `test/run-tests.js` | 51 loģikas tests (kļūdu klasifikācija, režīmi, sargsuņa lēmumi, straumes imitācija), bez interneta un atslēgas |
| `test/mocks.js` | Pārlūka testiem: viltots mikrofons (SpeechRecognition) un viltots OpenAI (labi, iekāras, apstājas pusceļā, 401, kredīts beidzies, 429) |
| `test/make-icons.rb` | Ģenerē PNG ikonas no tām pašām formām kā `icons/icon.svg` |

Testu palaišana uz šī Mac (node nav, izmanto iebūvēto JavaScriptCore):

```
cd translator-app
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test/run-tests.js
```

Pārlūka tests ar viltotu mikrofonu un OpenAI: izveido kopiju `index.html` ar `<script src="test/mocks.js"></script>` pirms `core.js` (piemēram `test-harness.html` lietotnes mapē), palaid lokālu serveri (`ruby -run -e httpd . -p 8765`) un konsolē vadi: `MOCK.rec().interim('...')`, `MOCK.rec().final('...')`, `MOCK.api = 'hang'`, `MOCK.swallowEnd = true`. Šo kopiju nepublicē.

## Kā tas strādā

1. **Runas atpazīšana**: Chrome `webkitSpeechRecognition`, `lang=en-US`, `continuous`, `interimResults`. Android Chrome pārtrauc klausīties pēc klusuma vai ~1 minūtes, tāpēc lietotne pati restartē atpazīšanu (250 ms, pie atkārtotām kļūdām līdz 4 s). Sargsuns ik pa 3 s pārbauda, vai klausīšanās nav "iesprūdusi". Android Chrome mēdz atkārtot iepriekšējo tekstu jaunajā rezultātā, to filtrē `newFinalPart`.
2. **Starpteksts** parādās uzreiz (angļu rindiņa). Ātrajā režīmā starpteksts tiek tulkots ne biežāk kā reizi 1,2 s, tikai ja pieauga vismaz par 2 vārdiem. Kad atnāk gala rezultāts, starptulkojums tiek atcelts un gala tulkojums straumējas tajā pašā rindiņā.
3. **Tulkošana**: OpenAI Chat Completions ar straumēšanu. Sistēmas uzdevums: dabiska runātā latviešu valoda, vārdi, uzņēmumu nosaukumi un termini paliek, atpazīšanas kļūdas labo no konteksta, bez garajām domuzīmēm. Kontekstam tiek doti 3 iepriekšējie angļu teikumi (netulkojami). Neizdevies gala tulkojums tīkla kļūdas gadījumā tiek atkārtots vienreiz.
4. **Ekrāns**, divi režīmi (poga `1` / `≡` augšējā joslā vai ⚙):
   - **A, "Tikai pašreizējais teikums"** (noklusējums): ekrāna vidū liels tikai tas teikums, kas tiek runāts tagad; iepriekšējais mazs un pelēks virs tā. Nākamais teikums aizstāj iepriekšējo.
   - **B, "Visa vēsture"**: redzami pēdējie 7 teikumi (iestatāms 3 līdz 12), vecākie izbalē, pašreizējais teikums **dzeltenā** (melnajā fonā dzelteni burti, baltajā fonā dzeltens marķieris ar melniem burtiem).
5. **Statuss un kļūdas**: augšējā kreisajā stūrī statuss (Klausās, Klausās · tulko, Ieslēdz mikrofonu…, Restartē…, Fonā, Apturēts). Punkts mirgo, kad mikrofons dzird skaņu. Ja OpenAI neatbild vai atgriež kļūdu, zem joslas parādās josla ar iemeslu latviski: dzeltena (īslaicīga, mēģina vēlreiz) vai sarkana (jārīkojas: nederīga atslēga, beidzies kredīts vai limits, modelis nav pieejams, nav mikrofona atļaujas).
6. **Diagnostika** (⚙ → Diagnostika): pēdējie 60 notikumi (atpazīšanas start/end/error, restarti, tulkojumu kļūdas, ekrāna nomodā turēšana). Ja kaut kas apstājas, ekrānuzņēmums no šī saraksta parāda iemeslu.

## Apstāšanās kļūda (22.11) un labojums

Lietotājs ziņoja: tulkošana sākas, bet pēc kāda laika apstājas un vairs neparādās. Visticamākie cēloņi iepriekšējā versijā:

1. **Tulkošanas pieprasījumiem nebija noildzes.** Ja OpenAI atbilde "iekāras" (mobilais internets, straume apstājas pusceļā), starptulkojuma karogs `busy` palika ieslēgts uz visiem laikiem, un starptulkojumi vairs netika sūtīti. Android Chrome ilgā runā gala rezultātus dod reti, tāpēc izskatījās, ka tulkošana apstājusies. Tagad: kopējā noildze (15 s gala, 6 s starptulkojumam) un "klusuma" noildze straumei (7 s / 4 s bez neviena gabaliņa), pēc tam līdz 3 atkārtojumiem ar pieaugošu pauzi (0,8 s, 2,5 s, 6 s).
2. **"Iekārusies" runas atpazīšana netika atjaunota.** Sargsuns pēc 60 s klusuma izsauca `abort()`, bet, ja Chrome nesūtīja `onend`, lietotne uzskatīja, ka atpazīšana vēl strādā, un nekad to nerestartēja. Tagad vecais atpazinējs tiek izmests (tā vēlie notikumi tiek ignorēti), tiek izveidots jauns, sargsuns pārbauda ik pēc 3 s un "iesit" pēc 30 s bez neviena notikuma, kā arī tad, ja pēc `start()` 6 s nepienāk `onstart` vai pēc kļūdas 1,5 s nepienāk `onend`.
3. **`not-allowed` / `service-not-allowed` pilnībā apturēja lietotni** ar logu, lai gan Android Chrome to mēdz izmest īslaicīgi pēc daudziem restartiem. Tagad aptur tikai tad, ja mikrofons nekad nav strādājis vai kļūda atkārtojas vairāk nekā 5 reizes pēc kārtas.
4. **Kļūdas nebija redzamas**: tās rādīja tikai mazajā statusā. Tagad ir kļūdu josla.
5. **Ekrāna nomodā turēšana**: ja Android to atlaida (piemēram, enerģijas taupīšana), tā netika pieprasīta atkārtoti. Tagad tiek pieprasīta no jauna pēc atlaišanas un sargsuņa pārbaudē.

## Modelis

Noklusējums **gpt-4.1-mini**: ātrs (bez "domāšanas" soļa, tātad zema aizture), labs latviešu valodā, lēts. Iestatījumos var ierakstīt jebkuru modeli:

- `gpt-4o-mini`: lētāks, latviešu valoda nedaudz vājāka.
- `gpt-4.1-nano`: vislētākais no ātrajiem, latviešu valodā jūtami vājāks.
- `gpt-5-nano` / `gpt-5-mini`: "domājošie" modeļi; lietotne tiem sūta `reasoning_effort: minimal`, bet aizture tāpat parasti lielāka. Var izmēģināt, ja kvalitāte svarīgāka par ātrumu.

Pirms lietošanas iestatījumos nospied **Pārbaudīt**: tiek iztulkots testa teikums un parādīts laiks sekundēs.

## OpenAI atslēga un drošība

- Atslēga **nav** kodā un nav repozitorijā. Lietotājs to ielīmē ⚙ iestatījumos, tā glabājas tikai telefona `localStorage` un tiek sūtīta tikai uz `api.openai.com`.
- Ieteikums: OpenAI kontā izveidot **atsevišķu projekta atslēgu** tikai šai lietotnei un projektam uzlikt mēneša tēriņu limitu (piemēram 5 USD). Ja telefons pazūd, atslēgu var atsaukt.
- Kods ir publisks (GitHub Pages), bet tas neko neatklāj, jo atslēgas tajā nav.

## Bezmaksas variants

- **Chrome iebūvētais tulkotājs** (Translator API) ir iestatījumos kā otrs variants, skaidri atzīmēts kā zemākas kvalitātes. Tas strādā ierīcē, bez maksas, bet bez konteksta. Šobrīd tas parasti pieejams tikai datora Chrome, Android telefonā tas visticamāk būs neaktīvs (lietotne to pārbauda un pasaka).
- **MyMemory** un līdzīgi bezmaksas API netika pievienoti: anonīmais limits ir ap 5000 rakstzīmēm dienā, bet stundas sapulce ir ap 40 000 līdz 50 000 rakstzīmju, tātad tas apstātos pirmajās 10 minūtēs. Tas nav uzticami.

## Izmaksas stundā (aplēse)

Pieņēmumi: runas ātrums ~130 vārdi minūtē, ~600 gala fragmentu stundā, ātrajā režīmā vēl ~600 starptulkojumu. Viens pieprasījums ≈ 330 ievades žetoni (uzdevums + konteksts + teksts) un ≈ 60 izvades žetoni (latviešu teksts).

| Modelis | Cena (ievade / izvade par 1M žetonu, jāpārbauda) | Ātrais režīms | Bez ātrā režīma |
|---|---|---|---|
| gpt-4.1-mini | ~0,40 / 1,60 USD | **~0,27 USD/h** | ~0,14 USD/h |
| gpt-4o-mini | ~0,15 / 0,60 USD | ~0,10 USD/h | ~0,05 USD/h |
| gpt-5-nano | ~0,05 / 0,40 USD | ~0,05 USD/h + domāšanas žetoni | ~0,03 USD/h |

Tātad pat ar labāko noklusējuma iestatījumu stunda maksā mazāk par 0,30 USD, 20 sapulču stundas mēnesī ap 5 USD. Cenas ir aptuvenas, pirms lietošanas jāpārbauda https://openai.com/api/pricing/. Runas atpazīšana (Google, caur Chrome) ir bez maksas.

## Skaņa no datora skaļruņiem telefona mikrofonā

- **Atbalss nav problēma**: telefons pats neko neatskaņo, tātad nav atgriezeniskās saites. Problēma ir tikai skaņas kvalitāte un fona trokšņi.
- **Precizitāte**: Google runas atpazīšana no skaļruņa parasti ir laba, ja skaņa ir skaidra un pietiekami skaļa. Sliktāk: klēpjdatora mazie skaļruņi, liela atbalss telpā, vairāki runātāji vienlaikus, spēcīgs akcents.
- **Padomi**:
  - telefonu likt 20 līdz 50 cm no skaļruņa, mikrofonu (telefona apakšu) pavērst pret skaļruni;
  - datora skaļumu 60 līdz 80 %, bez "telpiskās skaņas" efektiem;
  - ja izmanto austiņas, telefons neko nedzirdēs: tad vai nu skaļruņi, vai otrs variants zemāk;
  - paša runātais latviski vai angliski arī tiks atpazīts un tulkots, tāpēc savas runas laikā vari nospiest Apturēt vai ignorēt;
  - Android Chrome katru reizi, kad atpazīšana restartējas, var atskanēt īss signāls. To var noslāpēt, telefonā izslēdzot multivides/paziņojumu skaņu (atpazīšana turpinās).
- **Alternatīva bez mikrofona**: Google Meet un Microsoft Teams paši piedāvā tiešraides subtitrus un (maksas plānos) tulkotus subtitrus. Ja sapulce ir tur un latviešu valoda ir atbalstīta, tas ir tīrāks signāls. Šī lietotne der jebkurai platformai un klātienes sapulcēm.

## Izvietošana GitHub Pages

Lietotne ir repozitorijā `armands87/sapulces-tulks` (publisks, GitHub Pages): `https://armands87.github.io/sapulces-tulks/`. Augšupielādi veic koordinators pēc lietotāja apstiprinājuma. Uz šī Mac nav `git` (nav Xcode komandrindas rīku), tāpēc faili tiek augšupielādēti caur `gh api` vai GitHub tīmekļa saskarni.

Publicējamie faili: `index.html`, `style.css`, `core.js`, `app.js`, `sw.js`, `manifest.json`, `icons/`, `README.md`. Mapi `test/` var publicēt vai nepublicēt (lietotne to neielādē). Nekad nepublicē lapu, kas ielādē `test/mocks.js`.

Piezīmes:
- Bezmaksas GitHub plānā Pages strādā tikai publiskiem repozitorijiem. Kods ir publisks, bet atslēgas tajā nav.
- Service worker izmanto "vispirms tīkls", tāpēc telefons jauno versiju saņem nākamajā atvēršanā (ja ne, aizver lietotni un atver vēlreiz). Katrā laidienā `sw.js` palielina `CACHE` versiju (pašlaik `tulks-v2`).

## Uzstādīšana telefonā

1. Chrome atver `https://armands87.github.io/sapulces-tulks/`.
2. Izvēlne ⋮ → **Pievienot sākuma ekrānam** (vai **Instalēt lietotni**).
3. Atver no ikonas, ⚙ → ielīmē OpenAI atslēgu → **Pārbaudīt** → **Gatavs**.
4. **Sākt** → atļauj mikrofonu. Ekrāns paliek ieslēgts, kamēr lietotne klausās.

## Zināmie ierobežojumi

- Testēts: 51 loģikas tests, sintakse un pārlūka scenāriji ar viltotu mikrofonu un OpenAI (normāla plūsma, iekārusies atbilde, straume apstājas pusceļā un atgūšanās, 401, beidzies kredīts, atpazīšana bez `onend`, `no-speech`, `not-allowed`), abi režīmi abos fonos. **Uz īsta Android telefona nav pārbaudīts**, vai Chrome Android uzvedas tieši tā, kā imitēts; to parāda ⚙ → Diagnostika.
- Web Speech API Chrome sūta skaņu uz Google serveriem atpazīšanai. Konfidenciālās sapulcēs tas jāņem vērā (tāpat kā tulkojamais teksts iet uz OpenAI).
- Ja telefons aiziet miegā vai lietotne tiek pārslēgta fonā, klausīšanās apstājas; atgriežoties tā atsākas automātiski.
- Aizture parasti ap 1 līdz 2 s pēc teikuma beigām (atpazīšana + tulkojums). Ātrais režīms rāda provizorisku tulkojumu jau runas laikā.
