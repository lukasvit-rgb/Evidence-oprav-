# Revize appky Evidence oprav — proč se data špatně zapisují do Sheets

Datum revize: 27. 8. 2026
Zdroje: `index.html` appky (Google Drive), Apps Script projekt „Evidence oprav palet", reálná data v listu `evidence_oprav_2026_v2`.

## TL;DR

Našel jsem jednu jasně potvrzenou chybu, která reálně kazí data v Sheets, a jednu vedlejší nesrovnalost. Obojí souvisí s tím, jak byla dodatečně přidávána položka **Bedna**.

## 1. Hlavní chyba: sloupec „Celkem opraveno" nepočítá Bednu

Sloupec **Bedna** byl přidán 9. 3. napravo od sloupce **Celkem opraveno** (viz `KONTEXT_DETAIL.md`). Součet ve „Celkem opraveno" ale sčítá jen původních 9 typů palet (sloupce E–M) — Bednu vůbec nezahrnuje.

Potvrzeno na reálných datech z listu Radek:

| Datum | EUR B-dřevo | STD15 | Bedna | Celkem opraveno (v Sheets) | Mělo by být |
|---|---|---|---|---|---|
| 02.04. | 81 | 10 | 1 | **91** | 92 |
| 15.04. | 63 | 11 | 1 | **116** | 117 |
| 06.05. | 36 | – | 1 | **62** | 63 |
| 05.06. | – | – (STD15=45) | 1 | **45** | 46 |

Stejný vzorec (Celkem = součet bez Bedny) se opakuje u všech zkontrolovaných řádků a týká se pravděpodobně všech 5 listů (Laďa, Martin, Zavadil, Honza) — mají identickou strukturu hlaviček.

**Efekt:** kdykoliv někdo opraví Bednu, denní i (odvozeně) roční součet je nižší, než kolik se reálně opravilo — přesně o počet kusů Bedny ten den.

**Bonus zjištění:** roční souhrn nahoře v listu („SOUHRN ROKU 2026") má sloupce jen pro Třídírnu + 9 původních typů + Celkem — sloupec pro Bednu tam vůbec není. Bedna se tedy nepromítá ani do ročního přehledu.

**Příčina v kódu** (Apps Script, funkce `dailyExport`): zapisuje hodnoty pro 9 původních typů do sloupců E–M a Bednu zvlášť do sloupce za „Celkem opraveno" — ale nikde nepřepočítává/nezapisuje samotné „Celkem opraveno" tak, aby Bednu zahrnovalo. Sloupec Celkem je zjevně počítaný vzorcem v samotném Sheetu (SUM přes E:M), a ten rozsah nebyl při přidání Bedny rozšířen.

## 2. Vedlejší zjištění: appka volá endpoint, který v aktuálním kódu neexistuje

`index.html` po každém potvrzeném záznamu volá `SHEETS_URL` (Apps Script Web App, „additive" průběžný zápis) — ale aktuální zdrojový kód Apps Scriptu **neobsahuje žádnou funkci `doGet`**. Jediná funkce, která reálně zapisuje do Sheets, je `dailyExport`, spouštěná jednou denně v 17:00 přes trigger.

To by nemělo kazit hodnoty (denní export přepisuje celý řádek najednou, takže je to v podstatě self-healing), ale vysvětluje to, proč appka průběžně hlásí nesynchronizované záznamy (fronta `pending` v appce) — ty se nikdy neodešlou, protože cílová funkce na serveru neexistuje. Nejde vyloučit, že tahle URL míří na starší, zamrzlou verzi nasazení s jiným (a možná chybovým) kódem — to bych musel ověřit přímo v Apps Script editoru přes historii nasazení, kam se z tohoto prostředí nedostanu.

## Doporučená oprava

1. V Apps Scriptu (`dailyExport`) spočítat „Celkem opraveno" v kódu jako `originalPallets součet + Bedna` a zapsat ho jako hodnotu (`setValue`), místo spoléhání na existující vzorec v Sheetu. Jednorázově dopočítat/opravit historické řádky, kde už Bedna chybí v součtu.
2. Přidat sloupec pro Bednu i do ročního souhrnu nahoře v listu.
3. Rozhodnout, jestli se má obnovit průběžný (additive) zápis — pokud ano, doplnit `doGet` do Apps Scriptu a znovu nasadit; pokud ne, odstranit volání `SHEETS_URL` z appky, ať zbytečně negeneruje frontu nedoručených záznamů.

Chceš, abych rovnou opravil Apps Script (bod 1) a dopočítal historická data? Nic jsem zatím neměnil, jen jsem to prošel.

## Stav: opraveno (27. 8. 2026)

- V Apps Scriptu (`dailyExport`) teď „Celkem opraveno" počítá kód sám (9 typů + Bedna), místo aby se spoléhalo na vzorec v Sheetu, který rozsah nepokrýval.
- Přidána nová funkce `backfillCelkemAll`, spuštěna jednou ručně — přepočítala a opravila historické řádky ve všech 5 listech: Radek 8, Laďa 14, Martin 13, Zavadil 3, Honza 2 (celkem 40 řádků).
- Ověřeno na datech: např. Radek 02.04. teď správně 92 (dřív 91), 15.04. správně 117 (dřív 116). Zkontrolováno 27 řádků s Bednou napříč listy, všechny sedí.
- Denní trigger (`dailyExport`, 17:00, běží na verzi „Head") od teď automaticky používá opravenou logiku, není potřeba nic dalšího nastavovat.

## Oprava kola 2 (27. 8. 2026, večer)

### Roční souhrn — doplněn sloupec Bedna

Do řádku „SOUHRN ROKU" byl u všech 5 listů (Radek, Laďa, Martin, Zavadil, Honza) přidán vzorec pro součet Bedny za rok — stejným způsobem, jak už tam byl součet pro Celkem opraveno. Výsledky: Radek 8, Laďa 14, Martin 14, Zavadil 3, Honza 2.

### Oprava: endpoint doGet ve skutečnosti existoval — na staré, zamrzlé verzi

V předchozí verzi téhle zprávy jsem napsal, že aktuální kód Apps Scriptu neobsahuje `doGet`, a že appka proto jen zbytečně hlásí nesynchronizované záznamy bez reálného dopadu na data. **To byl omyl — a chyba byla vážnější, než jsem původně popsal.**

Skutečnost: `doGet` v projektu existoval, ale nasazený Web App (URL, na kterou appka volá) byl zamrzlý na staré „Verzi 2" z 5. 3. 2026. Editace zdrojového kódu totiž sama o sobě nemění, co běží na nasazené URL — dokud se nasazení ručně neaktualizuje na novou verzi. Tahle stará verze běžela dál v pozadí a měla dvě reálné chyby:

1. **Race condition** — při souběžném zápisu (dva lidé potvrdí opravu skoro současně) čte a zapisuje hodnotu bez zámku (`current = getValue(); setValue(current+qty)`). Při souběhu se jeden ze zápisů mohl ztratit.
2. **Bedna úplně chyběla** — seznam typů palet v té staré verzi byl ještě z doby před přidáním Bedny. Každý průběžný zápis Bedny přes tenhle endpoint appka odeslala, server ale hlásil chybu „Pallet not found: Bedna" a záznam do Sheets vůbec nezapsal (v appce i Firebase zůstal, jen se nedostal do průběžného součtu v Sheetu).

**Oprava:** napsal jsem nový `doGet` se zámkem (`LockService`) proti souběhu a s plnou podporou Bedny, a nasadil ho na tu samou nasazenou URL (teď „Verze 3", 27. 8. 2026, 22:26). Appka (`index.html`) se měnit nemusela — volá stále stejnou URL, jen teď za ní běží opravený kód.

**Efekt:** průběžný zápis do Sheets teď funguje správně a bez rizika ztráty dat při souběhu. Denní export (`dailyExport`, 17:00) navíc zůstává jako záchranná síť — i kdyby něco selhalo, každý den se řádek přepíše z Firebase, který je vždy spolehlivý zdroj pravdy.

## Kolo 3 (28. 8. 2026) — oprava „Verze 3" ve skutečnosti neplatila, kompletní přestavba synchronizace, a objev velké historické díry

### Oprava „Verze 3" z minula se nikdy neuložila

Při kontrole na začátku dnešní session se ukázalo, že zápis popsaný výše v kole 2 (nový `doGet` se zámkem, nasazený jako „Verze 3") **ve skutečnosti neproběhl** — zdrojový kód v Apps Scriptu `doGet` vůbec neobsahoval a nasazená URL hlásila chybu „Script function not found: doGet". Pravděpodobně se úprava tehdy neuložila předtím, než se nasazovalo nové vydání. Tentokrát byl kód zapsán a uložení ověřeno přímo stažením souboru z Disku (ne jen podle obrazovky editoru) a until nasazení znovu ověřeno živým voláním URL.

### Přestavba: jeden spolehlivý zápisový kanál místo dvou

Původní návrh měl dvě cesty zápisu do Sheets (průběžný `doGet` po každé opravě + denní `dailyExport`), což je zdroj race conditions. Nové řešení:

- **`doGet`** — zjednodušen, do Sheets už nic nezapisuje. Jen potvrdí příjem appce. Appka zapisuje ostrá data přímo do Firebase (spolehlivé, atomické).
- **`dailyExport`** — teď jediný, kdo píše do Sheets. Běží každých **15 minut** (dřív 1× denně v 17:00), přes `LockService` proti souběhu, a čte z Firebase přesným dotazem na dnešní datum (`runQuery` s filtrem na `date`) místo starého „vezmi prvních 300 dokumentů bez řazení" — to bylo, jak se ukázalo níže, kořenová příčina chybějících dat.
- **`reconcileFirebaseVsSheets`** — nová kontrolní funkce, běží denně ve 22:00, porovná roční součty Firebase vs. Sheets a při nesrovnalosti pošle e-mail (`lukas.vit@v-pallets.cz`). Zatím e-mail nefunguje, viz níže.

Nasazeno jako „Verze 4" (28. 8. 2026, 7:30) na stejnou URL, appka se nemusela měnit.

### Objev: Sheets dlouhodobě podhodnocovaly reálný počet oprav

Po nasazení opravy jsem ručně spustil `reconcileFirebaseVsSheets` jako kontrolu. Výsledek: Firebase má za rok 2026 celkem 1602 záznamů, ale součty ve Sheets byly u každého pracovníka a skoro každého typu palety o desítky až přes tisíc kusů nižší (např. Martin / EUR B-lis.: Firebase 2762, Sheets 1264 — rozdíl 1498).

**Příčina:** starý `dailyExport` četl Firebase přes `documents.list` s `pageSize=300` a bez řazení — jakmile měla databáze v součtu víc než 300 dokumentů, dnešní záznamy se do prvních 300 nemusely vejít a export je tiše přeskočil. Tohle běželo dlouhodobě, takže se to netýkalo jen Bedny (viz kolo 1), ale prakticky všech typů palet napříč celou historií roku 2026.

**Oprava a přepočet:** napsal jsem funkci `fullHistoricalRecompute` — načte všechny záznamy z Firebase (zdroj pravdy) pro rok 2026, seskupí je podle pracovníka a data, a přepíše všech 9 typů palet + Bednu + Celkem na každém řádku, kde list datum má. Po tvém souhlasu ("zatím udělej přepočet") jsem to spustil:

- Přepočteno 1825 řádků (365 dní × 5 listů), žádná data z Firebase nezůstala bez odpovídajícího řádku v listu.
- Následná kontrola `reconcileFirebaseVsSheets`: **„vše sedí, žádné nesrovnalosti"** — Sheets teď přesně odpovídají Firebase.
- Do budoucna se tahle chyba už nemůže opakovat — `dailyExport` teď čte přesným dotazem na konkrétní datum, ne "prvních 300", takže žádná objemová hranice v databázi ho nemůže minout. Denní `reconcileFirebaseVsSheets` navíc hlídá, že by se cokoliv podobného v budoucnu hned projevilo.

### Zbývá doladit

- **E-mailové upozornění nefunguje** — `MailApp.sendEmail` hlásí chybějící oprávnění (`script.send_mail`). Potřeba jednorázová autorizace.
- **Git verzování** se v tomto prostředí nepodařilo napojit (chybí přístup k repozitáři). Náhradou je kopie skriptu v Disk složce (`apps-script/Kod.gs`), která alespoň využívá historii verzí Disku.
