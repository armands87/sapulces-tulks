# Sapulces tulks

Telefona tīmekļa lietotne (PWA): klausās angļu runu caur mikrofonu un uzreiz rāda latviešu tulkojumu lieliem burtiem. Paredzēta Chrome pārlūkam Android telefonā, kas sapulces laikā stāv uz galda blakus datoram un uz kuru skatās ar acs kaktiņu.

## v7 (22.11): vienmērīgāka plūsma un labošana pēc konteksta

### 1. Raustīšanās un aizture

Kur radās "aizķeršanās":
- **Frāzes gaidīšana**: frāze tika sūtīta tikai pēc 4 stabiliem vārdiem vai 0,6 s pauzes.
- **"Grūdiens, pauze, grūdiens"**: frāzes tulkojums (4 līdz 5 vārdi) parādījās ar 3,5 vārdiem/s, tad ekrāns stāvēja, līdz atnāca nākamā frāze. Ja OpenAI atbildēja lēnāk (300 līdz 1300 ms svārstības mobilajā tīklā), pauze bija ilga un izskatījās, ka viss sastingst.
- **Paslēptā josla** ar izplūduma efektu tika zīmēta arī tad, kad nebija redzama (lieks darbs telefonam).

Izmaiņas:
- Frāze tiek sūtīta pēc **3 stabiliem vārdiem** vai **0,45 s** pauzes (bija 4 un 0,6 s).
- **Elastīgs temps**: kad rindā ir tikai 1 līdz 3 vārdi, parādīšanās ātrums seko tam, cik ātri tulkojumi reāli pienāk (pēdējās 8 s), un pēdējais vārds rindā tiek nedaudz "izstiepts", lai nākamā frāze parasti paspēj atnākt, pirms ekrāns paliek tukšs. Lielai rindai paātrinājums kā v4 (līdz 7 vārdiem/s).
- **Gaidīšanas rādītājs**: ja vārdu tiešām nav, kursors "elpo" (lēni pulsē), nevis izskatās sastindzis.
- Rezerves pieprasījums (hedge) pēc 2,5 s (bija 3 s). Silts savienojums kā iepriekš.
- Paslēptā josla netiek zīmēta.

Mērījums imitācijā (tie paši 4 teikumi, 66 vārdi, 2,5 vārdi/s, OpenAI 300 līdz 1300 ms ar vienādu nejaušības sēklu):

| | v6 | v7 |
|---|---|---|
| Pauzes starp vārdiem > 0,7 s | 11 | **5** |
| Pauzes > 1 s | 5 | **1** |
| Garākā pauze | 1,66 s | **1,21 s** |
| 90 % paužu īsākas par | 0,88 s | **0,52 s** |
| Aizture līdz ekrānam (mediāna) | 1,97 s | **1,85 s** |
| Gaidīšana uz frāzi (mediāna) | 1,00 s | **0,80 s** |

Vidējā atstarpe starp vārdiem pieauga no 0,29 uz 0,38 s: tā ir vienmērīgāka plūsma, nevis lēnāka (kopējā aizture samazinājās).

### 2. Precizitāte: konteksts un labošana

Problēma: Chrome runas atpazīšana sadzird nepareizi (homofoni "write/right", sadalīti vārdi "write size" = "rightsize", sagrozīti vārdi un nosaukumi). Burtisks tulkojums tad ir neloģisks.

1. **Sapulces tēma, vārdi un nosaukumi**: jauns lauks sākuma ekrānā (un iestatījumos), piem. "Smoothbev, Roman, Sarah, EV lādētāji, Q3 budžets". Tas tiek iekļauts uzdevumā kā glosārijs: pareizā rakstība un "nepareizi sadzirdēts vārds visticamāk ir viens no šiem".
2. **Ātrā tulkojuma uzdevums** tagad skaidri saka: angļu teksts ir no automātiskās runas atpazīšanas, nosaki, ko runātājs domāja, tulko jēgu loģiskā latviešu valodā, nekad netulko acīmredzami nepareizi sadzirdētu vārdu burtiski, ja to nevar saprast, izlaid. Konteksts: ~500 rakstzīmes iepriekšējās angļu runas un ~500 rakstzīmes paša latviskā tulkojuma (apmēram 8 līdz 12 teikumi, bija 160).
3. **Labošana pēc konteksta** (iestatījumos, pēc noklusējuma ieslēgta): kad frāzes grupa (~8 vārdi vai teikuma beigas) ir parādīta un ir zināmi nākamie vārdi (vai pagājušas 2,5 s), tā tiek klusi pārbaudīta vēlreiz ar kontekstu pirms UN pēc tās, glosāriju un atpazīšanas alternatīvām. Atbilde JSON formā.
   - Ekrāns mainās **tikai**, ja jaunais tulkojums atšķiras būtiski (mainīts satura vārds vai 2+ vārdi; pieturzīmes, lielie burti un viens īss vārds neskaitās), rinda jau ir pilnībā parādīta, vēl redzama un lietotājs nav ritinājis atpakaļ lasīt. Tad īsa pārzīmēšana (0,2 s izgaišana, 0,5 s parādīšanās) un smalks punktēts pasvītrojums.
   - Pieraksts **vienmēr** glabā labojumu; .html pierakstā mazā pārsvītrotā rindā redzams arī pirmais variants.
   - Imitācijā labojums parādās ~3 s pēc frāzes tulkojuma.
4. **Atpazīšanas alternatīvas**: `maxAlternatives = 3`; ja Chrome tās dod (Android bieži dod tikai vienu), tās tiek nodotas labošanai kā mājieni.

Piemērs imitācijā (`screens/8-correction-off.png` un `9-correction-on.png`):

| Atpazīts (EN) | Ātrais tulkojums | Pēc labošanas |
|---|---|---|
| we need to write size the budget | Mums vajag rakstīt izmēru budžetam. | Mums budžets jāpielāgo vajadzīgajam apjomam. |
| I spoke with roaming from smooth bev | Es runāju ar viesabonēšanu no gludā bev. | Es runāju ar Romanu no Smoothbev. |

(Imitācijā labojumus "zina" viltotais OpenAI; reālo kvalitāti nosaka modelis, skatīt zemāk.)

**Kompromiss, godīgi**: labošana nozīmē, ka teksts dažreiz mainās jau pēc parādīšanās, ko lietotājs agrāk negribēja. Tāpēc tikai būtiski labojumi, tikai redzamās rindās, tikai sekojot tiešraidei, ar mierīgu pārzīmēšanu. Ja tas traucē: iestatījumi → Labošana pēc konteksta → Izslēgta (precizitāti joprojām uzlabo glosārijs un garāks konteksts ātrajā tulkojumā). Īsākas frāzes (3 vārdi) ātrajā tulkojumā ir nedaudz sliktākas valodiski; to kompensē garāks konteksts un labošana.

### Izmaksas stundā (aplēse, cenas jāpārbauda openai.com/api/pricing)

| | stundā |
|---|---|
| Ātrais tulkojums gpt-4.1-mini (garāks konteksts, ~2200 pieprasījumi) | ~$0,52 |
| + labošana gpt-4.1-mini (~780 pieprasījumi) | +$0,25 (kopā **~$0,77**, noklusējums) |
| + labošana gpt-4.1 (precīzāks) | +$1,26 (kopā ~$1,79) |
| Labošana izslēgta | ~$0,52 |

v6 bija ~$0,16/h; pieaugums nāk no garākā konteksta (labākai precizitātei) un labošanas.

Ekrānuzņēmumi: `screens/1-start-topic.png` (sākuma ekrāns ar tēmas lauku), `screens/8-correction-off.png`, `screens/9-correction-on.png`.

## v6 (22.11): jauns, mierīgs interfeiss

Lietotājam nepatika v5 izskats. v6 pārbūvē visu interfeisu, loģika nemainās (subtitri, lasīšanas temps, apturēšana un "Atpakaļ uz tiešraidi", saglabāšana un atjaunošana, diagnostika, ātruma tests).

**Principi**: viena galvenā darbība katrā brīdī, viss pārējais paslēpts; teksts aizņem gandrīz visu ekrānu; vadība īkšķa sasniedzamībā apakšā; vienkārši latviski vārdi, nekādu "CC / 1 / ≡".

1. **Sākuma ekrāns** (nekas vēl nav teikts): viena liela apaļa poga ar mikrofonu "Sākt", zem tās īss paskaidrojums. Augšā mazs statuss ("Gatavs") un diskrēta zobrata ikona. Ja nav OpenAI atslēgas, zem pogas "Pievienot OpenAI atslēgu". Iepriekšējās sarunas atjaunošana ir kartīte šajā ekrānā.
2. **Klausoties**: ekrānā tikai teksts un mazs statuss augšā ("Klausās · 1,4 s", kavējuma uzlīme, ja atpaliek). Apakšā peldoša josla ar tikai būtisko: teksta izmērs (mazs A / liels A), "Saglabāt", "Apturēt". Josla un zobrats izgaist pēc 4 s; **pieskāriens tekstam** tos parāda atkal (vēl viens pieskāriens paslēpj). Josla neaizsedz tekstu un tās parādīšanās tekstu nepārbīda.
3. **Pēc Apturēt**: teksts paliek, josla redzama pastāvīgi ar "Turpināt" (galvenā poga) un "Saglabāt".
4. **Iestatījumi**: lapa, kas izslīd no apakšas, ar grupām: *Izskats* (tēma Tumšā / Gaišā / Automātiski, teksta izmērs, rādīšana Subtitri / Tikai teikums / Vēsture, redzamās rindas, angļu oriģināls), *Teksta plūsma* (parādīšanās ātrums, tulkošana pa īsām frāzēm / garākām / teikumiem), *Tulkošana* (OpenAI vai Chrome, atslēga, modelis, Pārbaudīt, Ātruma tests), *Cits* (Saglabāt sarunu, Pilnekrāns, Notīrīt ekrānu, Diagnostika). Izmaiņas redzamas uzreiz, aiz lapas.
5. **Saglabāšana**: tāda pati lapa no apakšas, izvēles kā segmentu slēdži, viena galvenā poga "Saglabāt vai nosūtīt", zem tās "Lejupielādēt" un "Kopēt tekstu", apakšā "Jauna saruna".
6. **Stils**: viena fontu kopa (Inter, ja ierīcē ir, citādi sistēmas fonts, piem. Roboto; nekādu ārēju pieprasījumu), viena akcenta krāsa (zila), sarkans tikai "Apturēt", dzintara krāsa tikai jaunākajiem vārdiem. Noapaļotas formas, pieskārienu laukumi 48 px, drošās zonas (iegriezumi, žestu josla), mierīgas pārejas (atslēdzas, ja telefonā ieslēgts "samazināt kustību"). Tumšā tēma pēc noklusējuma, gaišā un automātiskā (pēc telefona iestatījuma).
7. Gramatika: "1 runas daļa", "21 vārds", "5 vārdi".

**Viena apzināta izmaiņa uzvedībā**: v4/v5 pieskāriens tekstam apturēja skatu. Tagad pieskāriens parāda vadību, un skats apstājas tikai tad, ja **ritina uz augšu** (tad parādās "Atpakaļ uz tiešraidi"). Citādi katrs pieskāriens, lai nospiestu Apturēt vai Saglabāt, apturētu skatu.

Ekrānuzņēmumi (390x844): `screens/1-start.png`, `2-listening-dark.png`, `3-listening-controls.png`, `4-settings.png`, `5-save.png`, `6-light.png`, `7-frozen.png`.

## v5 (22.11): sarunas saglabāšana

- **Poga "Saglabāt"** augšējā joslā kreisajā pusē (zaļa). Pieejama arī pēc Apturēt un ⚙ → "Saglabāt sarunu…".
- **Visa saruna, ne tikai ekrāns**: atsevišķa pieraksta krātuve (katra runas daļa: laiks no sākuma, latviešu tulkojums, angļu oriģināls), neatkarīga no ekrāna vēstures (kas ir līdz 400 daļām). 2 stundu sapulce ir ap 230 KB, telefona `localStorage` vieta ir ~5 MB.
- **Neatkarīga no pārlādes**: krātuve tiek ierakstīta `localStorage` ik pēc 2,5 s un vienmēr, kad lapa aiziet fonā vai tiek aizvērta. Pēc pārlādes augšā parādās "Atrasta iepriekšējā saruna… [Atjaunot iepriekšējo sarunu] [Sākt jaunu]". Atjaunotais teksts atgriežas ekrānā, un jaunā runa turpina to pašu sarunu (laiki turpinās). Ja nospiež Sākt, neko neizvēloties, saruna tiek atjaunota automātiski (lai nekas nepazūd). "Sākt jaunu" nesaglabātai sarunai vispirms jautā.
- **Saglabāšanas logs**: Saturs: Latviski + angliski / Tikai latviski. Formāts: Teksts (.txt) / Lapa telefonam (.html, lieli burti, gaišs un tumšs režīms). Pogas:
  - **Saglabāt / dalīties**: Android Chrome atver dalīšanās izvēlni ar failu (Drive, e-pasts, Telegram…). Ja dalīšanās nav pieejama, fails tiek lejupielādēts. Ja lietotājs dalīšanos atceļ, nekas netiek lejupielādēts.
  - **Lejupielādēt**: vienmēr parasta lejupielāde.
  - **Kopēt**: viss teksts starpliktuvē.
  - **Jauna saruna**: notīra pierakstu un ekrānu. Ja saruna nav saglabāta, pirmā nospiešana tikai brīdina ("Dzēst bez saglabāšanas"), otrā dzēš.
- **Faila nosaukums**: `sapulce-2026-11-22-1830.txt` (pirmās runas datums un laiks).
- **Saturs** (.txt, latviski + angliski):

```
Sapulces tulks: sarunas pieraksts
Sākums: 22.11.2026 18:30
Ilgums: 1 h 12 min, 143 runas daļas

[00:00:05]
LV: Paldies visiem, ka pievienojāties.
EN: thanks everyone for joining
```

  Tikai latviski: viena rinda katrai daļai, `[00:00:05] Paldies visiem, ka pievienojāties.` Neiztulkota daļa: `[nav iztulkots]` + angļu teksts.

Pārbaudīts: 97 loģikas testi (laiki, nosaukums, teksts, HTML ar drošu speciālo rakstzīmju apstrādi, 2 h sapulces apjoms); pārlūkā ar viltotu mikrofonu: pieraksts un glabāšana, pārlāde → atjaunošana → turpināšana, Jauna saruna divos soļos, dalīšanās (arī atcelta), lejupielāde .html tikai latviski, kopēšana. Dalīšanās, lejupielāde un starpliktuve pārbaudītas ar aizstātām pārlūka funkcijām, ne ar īstu Android dalīšanās izvēlni.

Ekrānuzņēmumi: `screens/live-dark.png` (josla ar pogu Saglabāt), `screens/save-dialog-dark.png`, kā arī `live-light`, `frozen-dark`, `frozen-light`.

## v4 (22.11): vienmērīga parādīšanās, nekas nepazūd

### Problēma (lietotāja atsauksme par v3)

Pēc nelielas aiztures (tīkls vai runas atpazīšana) liels teksta gabals atnāca uzreiz, "saskrēja kopā", aizslīdēja uz augšu un pazuda, pirms to varēja izlasīt.

### Kāpēc teksts nāca lielos gabalos

1. **Runas atpazīšana pati mēdz kavēties** un pēc tam atdod daudz vārdu uzreiz. Frāžu dalītājs no tiem uzreiz izveidoja vairākas frāzes, tās tika tulkotas paralēli un atgriezās gandrīz vienlaikus.
2. **Kārtībā turēšana**: ja viena frāze tulkojās lēni, nākamās jau bija gatavas, un, kad lēnā beidzot atnāca, viss parādījās uzreiz.
3. **Straumes apstāšanās** mobilajā tīklā darbojās tāpat: pauze, tad uzreiz viss.
4. v3 rādīja katru tulkoto vārdu tajā pašā mirklī, kad tas atnāca, un logs bija 5 rindas ar izbalināšanu augšā, tāpēc lēciens aiznesa tekstu ārpus redzamības.

### Risinājums

1. **Lasīšanas tempā (vārdu pa vārdam)**: tulkojumi nonāk rindā, un ekrānā vārdi parādās vienmērīgi, ~3,5 vārdi/s ("Normāli"). Ja rinda aug, temps paātrinās pakāpeniski (+0,35 vārdi/s par katru vārdu virs 4 rindā), bet ne ātrāk par 7 vārdiem/s. Nekas netiek izlaists vai apvienots. Pirmais vārds pēc klusuma parādās uzreiz, tāpēc parastā runā aizture nepieaug. Pēc teikuma beigām, ja rindā nav daudz, ir īsa 0,25 s elpas pauze. 40 vārdu "sprādziens" tiek parādīts ~7 s laikā, nevis vienā mirklī.
2. **Kavējuma rādītājs**: apakšā pie statusa dzeltens "Kavējums 5 s · 18 v.", kad ekrāns atpaliek no runas par vairāk nekā 4 s vai 8 vārdiem.
3. **Nekas nepazūd**: vecākais teksts netiek dzēsts (līdz 400 runas daļām), tas paliek ritināmā vēsturē virs tiešraides. Logs ir 7 rindas (iestatāms 4 līdz 12), tikai augšējā rinda ir nedaudz bālāka.
4. **Apturēšana un "Atpakaļ uz tiešraidi"**: pieskaries tekstam vai ritini uz augšu, un skats apstājas (teksts turpina nākt fonā). Parādās poga "Atpakaļ uz tiešraidi · 12 jauni vārdi". Nospiežot to vai noritinot līdz apakšai, skats atkal seko tiešraidei.
5. **Pauzes**: runas daļas elements ekrānā tiek izveidots tikai tad, kad parādās tās pirmais vārds, tāpēc klusuma laikā nekas nekustas. Jauna rinda tikai pēc īstas pauzes (>2,5 s), kā iepriekš.
6. **Lēna pieprasījuma "nodrošināšana" (hedge)**: ja 3 s laikā nav atnācis neviens tulkojuma vārds, tiek nosūtīts otrs tāds pats pieprasījums; kurš pirmais sāk straumēt, tas uzvar, otrs tiek atcelts. Straumes klusuma noildze 4 s. Silts savienojums paliek.
7. **Iestatījumi**: "Teksta parādīšanās ātrums": Lēnāk (2,5, līdz 5,5 vārdi/s) / Normāli (3,5, līdz 7) / Ātrāk (4,5, līdz 9). "Subtitru loga augstums": 4 līdz 12 rindas.

Pārbaudīts pārlūkā ar viltotu mikrofonu un OpenAI (OpenAI 400 ms līdz pirmajam vārdam):
- **Sprādziens**: 6 s klusums, tad 40 vārdi uzreiz. Sadalīti 6 frāzēs (līdz 8 vārdiem), 38 tulkotie vārdi parādījās ne ātrāk kā 7 vārdi/s (mazākā atstarpe 144 ms), pirmais pēc 0,44 s, visi 7,0 s laikā; kavējuma rādītājs parādījās.
- **Nekas nepazūd**: ekrānā 48 vārdi = 48 tulkotie vārdi.
- **Hedge**: pirmais pieprasījums "iekāras" (8 s), otrais pēc 3 s uzvar, frāze gatava 4,15 s (bez hedge būtu ~8,4 s).
- **Apturēšana**: pēc pieskāriena skats nekustas, kamēr fonā nāk 9 jauni vārdi; poga rāda "9 jauni vārdi"; pēc pogas skats atkal apakšā, poga pazūd.
- **Pauze**: 3 s klusumā nekas nekustas.

Statusā "Klausās · X s" tagad ir laiks līdz brīdim, kad frāzes pirmais vārds **parādās ekrānā** (ar lasīšanas rindu). Diagnostikā ir sadalījums: gaidīšana uz frāzi, OpenAI, rinda ekrānā un cik vārdu gaida.

Ekrānuzņēmumi (390x844, viltots mikrofons un OpenAI, nepublicēt): `screens/live-dark.png`, `screens/live-light.png`, `screens/frozen-dark.png`, `screens/frozen-light.png`.

## v3 (22.11): subtitru skats un mazāka aizture

### Problēma

v2 rādīja tulkojumu pa teikumiem. Teksts parādījās tikai pēc teikuma beigām, ātrajā režīmā provizoriskais tulkojums tika pārrakstīts (vārdi lēca un mainījās), un acs nezināja, kur ir "tagad". Aizture līdz stabilam tekstam bija 4 līdz 6 s.

### Jaunais skats "Subtitri" (noklusējums, poga `CC`)

Principi, pēc kuriem tas veidots (TV subtitri, telepromteris, tiešraides titri konferencēs):

1. **Fiksēts logs ekrāna vidū** (v4: 7 rindas un ritināma vēsture). Jaunākā rinda vienmēr ir tajā pašā vietā, tāpēc acs, uzmetot skatienu, uzreiz zina, kur skatīties.
2. **Teksts tikai pieaug beigās, nekas netiek pārrakstīts.** Runa tiek tulkota īsās frāzēs (~4 vārdi vai līdz pauzei). Katra frāze tiek pievienota beigās un pēc tam nemainās. Tā kā rindu pārnešana notiek tikai pēdējā rindā, augšējās rindas nekad nepārkārtojas.
3. **Jaunākā frāze ir izcelta** ar mierīgu dzintara krāsu (baltajā fonā dzeltens marķieris), aiz tās mirgo kursors. Kad atnāk nākamā frāze, iepriekšējā lēni (0,9 s) kļūst parastā krāsā. Acs redz, kur ir "tagad", un var vienā skatienā izlasīt arī iepriekšējo rindu.
4. **Vecākās rindas aizslīd uz augšu** (v4: tās paliek ritināmā vēsturē, nekas netiek dzēsts).
5. **Jauna runas daļa pēc garākas pauzes (>2,5 s) sākas jaunā rindā** ar nelielu atstarpi, tāpat kā rindkopa.
6. **Kontrasts un lasāmība**: tumšajā fonā gandrīz balts (#f2f2f2, mazāk žilbina nekā tīri balts), treknraksts, rindstarpa 1,32, 40 px pēc noklusējuma (A−/A+ maina).
7. **Angļu oriģināls** tikai kā viena bāla rindiņa zem loga (poga `EN`, pēc noklusējuma izslēgts).
8. Statuss un lielā poga ir apakšā, augšējā josla ir tikai pogas un darba laikā ir bāla.

(v3 ekrānuzņēmumi aizstāti ar v4 ekrānuzņēmumiem, skatīt augstāk.)

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
| `index.html`, `style.css` | v6 interfeiss: sākuma ekrāns, subtitri, apakšējā josla (izmērs, Saglabāt, Apturēt/Turpināt), iestatījumu un saglabāšanas lapas |
| `app.js` | Runas atpazīšana ar automātisku restartu un sargsuni, frāžu dalītājs, paralēla straumēta tulkošana, kļūdu josla, aiztures mērījums, ātruma tests, Wake Lock, stenogramma |
| `core.js` | Loģika bez DOM: frāžu dalītājs, uzdevums, kļūdu klasifikācija, sargsuņa lēmumi, straumes parsētājs |
| `sw.js`, `manifest.json`, `icons/` | PWA (pievienot sākuma ekrānam, pilnekrāns). Kešatmiņas versija `tulks-v7` |
| `test/run-tests.js` | 128 loģikas testi (arī labošanas, elastīgā tempa, pieraksta un locījumu testi), bez interneta un atslēgas |
| `test/mocks.js` | Viltots mikrofons (arī `MOCK.speak` ar runas ātrumu, `MOCK.slowCalls` lēna pieprasījuma testam) un viltots OpenAI (labi, iekāras, apstājas, 401, kredīts, 429; aizture `MOCK.ttft`) |
| `test/demo.js` | Scenārijs ekrānuzņēmumiem (`#demo-start`, `#demo-dark`, `#demo-dark-controls`, `#demo-dark-settings`, `#demo-dark-save`, `#demo-dark-frozen`, `#demo-light-controls`) |
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

Pēc atjaunināšanas telefonā lietotni aizver un atver vēlreiz (service worker: "vispirms tīkls", kešatmiņa `tulks-v7`). v4 vienreiz iestata subtitru logu uz 7 rindām (vecākām versijām arī subtitru režīmu); atslēga saglabājas.

## Uzstādīšana telefonā

1. Chrome atver `https://armands87.github.io/sapulces-tulks/`, izvēlne ⋮ → **Pievienot sākuma ekrānam**.
2. ⚙ → ielīmē OpenAI atslēgu → **Pārbaudīt** → **Ātruma tests** → **Gatavs**.
3. **Sākt** → atļauj mikrofonu.

## Zināmie ierobežojumi

- Testēts: 66 loģikas testi, pārlūka scenāriji ar viltotu mikrofonu un OpenAI (subtitru plūsma, frāžu secība, aizture trim soļiem, iekārusies atbilde un atgūšanās, 401 ar angļu teksta rezervi, visi trīs režīmi, abi foni). **Uz īsta Android telefona nav pārbaudīts**: kā Android Chrome starprezultāti mainās (cik bieži tiek laboti jau nosūtītie vārdi), īstā aizture un frāžu tulkojumu valodas kvalitāte.
- Ja atpazīšana pārlabo vārdu, kas jau nosūtīts tulkošanai, ekrānā paliek pirmā versija (teksts apzināti netiek pārrakstīts).
- Web Speech API sūta skaņu Google, teksts iet uz OpenAI: jāņem vērā konfidenciālās sapulcēs.
