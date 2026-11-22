# Sapulces tulks

Telefona tīmekļa lietotne (PWA): klausās angļu runu caur mikrofonu un uzreiz rāda latviešu tulkojumu ļoti lieliem burtiem. Paredzēta Chrome pārlūkam Android telefonā, kas sapulces laikā stāv uz galda blakus datoram.

## Kas ir iekšā

| Fails | Nozīme |
|---|---|
| `index.html`, `style.css` | Ekrāns: melns fons ar baltiem burtiem (vai otrādi), liela poga Sākt/Apturēt, A−/A+ un slīdnis teksta izmēram, EN (angļu oriģināls zem tulkojuma), fona maiņa, pilnekrāns, ⚙ iestatījumi |
| `app.js` | Runas atpazīšana (Web Speech API, en-US, nepārtraukta, ar automātisku restartu), tulkošana, ekrāna nomodā turēšana (Wake Lock), stenogrammas saglabāšana |
| `core.js` | Loģika bez DOM (pieprasījuma uzbūve, straumes parsētājs, Android dublikātu filtrs, restarta aizture), testējama atsevišķi |
| `sw.js`, `manifest.json`, `icons/` | PWA: var pievienot sākuma ekrānam, atveras pilnekrānā |
| `test/run-tests.js` | Testi ar OpenAI atbildes imitāciju (bez interneta, bez atslēgas) |
| `test/make-icons.rb` | Ģenerē PNG ikonas no tām pašām formām kā `icons/icon.svg` |

Testu palaišana uz šī Mac (node nav, izmanto iebūvēto JavaScriptCore):

```
cd translator-app
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test/run-tests.js
```

## Kā tas strādā

1. **Runas atpazīšana**: Chrome `webkitSpeechRecognition`, `lang=en-US`, `continuous`, `interimResults`. Android Chrome pārtrauc klausīties pēc klusuma vai ~1 minūtes, tāpēc lietotne pati restartē atpazīšanu (250 ms, pie atkārtotām kļūdām līdz 4 s). Sargsuns ik pa 5 s pārbauda, vai klausīšanās nav "iesprūdusi". Android Chrome mēdz atkārtot iepriekšējo tekstu jaunajā rezultātā, to filtrē `newFinalPart`.
2. **Starpteksts** parādās uzreiz (angļu rindiņa). Ātrajā režīmā starpteksts tiek tulkots ne biežāk kā reizi 1,2 s, tikai ja pieauga vismaz par 2 vārdiem. Kad atnāk gala rezultāts, starptulkojums tiek atcelts un gala tulkojums straumējas tajā pašā rindiņā.
3. **Tulkošana**: OpenAI Chat Completions ar straumēšanu. Sistēmas uzdevums: dabiska runātā latviešu valoda, vārdi, uzņēmumu nosaukumi un termini paliek, atpazīšanas kļūdas labo no konteksta, bez garajām domuzīmēm. Kontekstam tiek doti 3 iepriekšējie angļu teikumi (netulkojami). Neizdevies gala tulkojums tīkla kļūdas gadījumā tiek atkārtots vienreiz.
4. **Ekrāns**: redzami pēdējie 7 teikumi (iestatāms 3 līdz 12), vecākie pakāpeniski izbalē, jaunākais vienmēr apakšā.

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

## Izvietošana GitHub Pages (vajag lietotāja apstiprinājumu)

Mikrofonam vajag HTTPS, tāpēc lietotnei vajag hostingu. GitHub Pages ir bez maksas. **Nekas vēl nav publicēts un neviens repozitorijs nav izveidots.**

Pēc apstiprinājuma (lietotājs `armands87`, `gh` jau ir pieslēgts):

```
cd /Users/armands/ClaudeTelegram/translator-app
git init -b main
git add .
git commit -m "Sapulces tulks: pirmā versija"
gh repo create armands87/sapulces-tulks --public --source=. --push
gh api -X POST repos/armands87/sapulces-tulks/pages -f "source[branch]=main" -f "source[path]=/"
```

Pēc 1 līdz 2 minūtēm lietotne būs adresē:
`https://armands87.github.io/sapulces-tulks/`

Piezīmes:
- Bezmaksas GitHub plānā Pages strādā tikai publiskiem repozitorijiem. Kods ir publisks, bet atslēgas tajā nav.
- Atjauninājumi: `git commit` + `git push`. Service worker izmanto "vispirms tīkls", tāpēc telefons jauno versiju saņem nākamajā atvēršanā. Ja mainās failu saraksts, `sw.js` jāpalielina `CACHE` versija.

## Uzstādīšana telefonā

1. Chrome atver `https://armands87.github.io/sapulces-tulks/`.
2. Izvēlne ⋮ → **Pievienot sākuma ekrānam** (vai **Instalēt lietotni**).
3. Atver no ikonas, ⚙ → ielīmē OpenAI atslēgu → **Pārbaudīt** → **Gatavs**.
4. **Sākt** → atļauj mikrofonu. Ekrāns paliek ieslēgts, kamēr lietotne klausās.

## Zināmie ierobežojumi

- Testēts: loģika (28 testi ar OpenAI atbildes imitāciju), sintakse, izskats datora Chrome. **Nav testēts uz īsta Android telefona ar mikrofonu un īstu atslēgu**, tas ir pirmais solis pēc izvietošanas.
- Web Speech API Chrome sūta skaņu uz Google serveriem atpazīšanai. Konfidenciālās sapulcēs tas jāņem vērā (tāpat kā tulkojamais teksts iet uz OpenAI).
- Ja telefons aiziet miegā vai lietotne tiek pārslēgta fonā, klausīšanās apstājas; atgriežoties tā atsākas automātiski.
- Aizture parasti ap 1 līdz 2 s pēc teikuma beigām (atpazīšana + tulkojums). Ātrais režīms rāda provizorisku tulkojumu jau runas laikā.
