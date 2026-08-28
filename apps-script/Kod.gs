const SHEET_ID = '1hUgMsGfdlj79b6lxx9Tb1fA5K1HjnfmbiytzBjDEeQA';
const PROJECT_ID = 'evidence-oprav';
const ALERT_EMAIL = 'lukas.vit@v-pallets.cz';
const PALLETS = ['EUR A','EUR B - lis.','EUR B - dřevo','STD05','STD10','STD15','100x120','100x120 rámové','Atypická','Bedna'];
const WORKERS = ['Radek','Laďa','Martin','Zavadil','Honza'];

function getTodayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function getTodaySheet() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.';
}

function sendErrorAlert(subject, message) {
  try {
    MailApp.sendEmail(ALERT_EMAIL, '[Evidence oprav] ' + subject, message);
  } catch (mailErr) {
    Logger.log('Nepodařilo se poslat alert email: ' + mailErr.message);
  }
}

function parseField(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue);
  if (field.doubleValue !== undefined) return parseFloat(field.doubleValue);
  return null;
}

// Načte jen dnešní záznamy přímo dotazem na Firestore (structured query),
// místo stahování prvních 300 dokumentů bez řazení (to mohlo dnešní
// záznamy minout, pokud jich je v databázi celkem víc než 300).
function fetchTodayFirestoreRecords() {
  const todayISO = getTodayISO();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const payload = {
    structuredQuery: {
      from: [{ collectionId: 'opravy' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'EQUAL',
          value: { stringValue: todayISO }
        }
      }
    }
  };
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('runQuery HTTP status: ' + resp.getResponseCode());
  const data = JSON.parse(resp.getContentText());
  const docs = (Array.isArray(data) ? data : []).filter(r => r.document).map(r => r.document);
  Logger.log('Počet dokumentů pro dnešek (' + todayISO + '): ' + docs.length);
  return docs;
}

// Stáhne úplně všechny dokumenty (se stránkováním) — pro roční kontrolu.
function fetchAllFirestoreRecords() {
  let allDocs = [];
  let pageToken = null;
  do {
    let url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/opravy?pageSize=300`;
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(resp.getContentText());
    if (data.documents) allDocs = allDocs.concat(data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  Logger.log('fetchAllFirestoreRecords: celkem dokumentů = ' + allDocs.length);
  return allDocs;
}

// Najde sloupec "Celkem opraveno" a sloupec "Bedna" (ten je vždy hned za Celkem).
// Pokud hlavička Bedna ještě neexistuje, doplní ji.
function findCelkemAndBednaCols(sheet) {
  const lastCol = sheet.getLastColumn();
  const headerRow = 7;

  let celkemCol = -1;
  for (let c = 1; c <= lastCol; c++) {
    const val = sheet.getRange(headerRow, c).getValue();
    if (val === 'Celkem opraveno') { celkemCol = c; break; }
  }

  if (celkemCol === -1) {
    Logger.log('Hlavička Celkem opraveno nenalezena');
    return { celkemCol: -1, bednaCol: -1 };
  }

  const bednaCol = celkemCol + 1;
  const existing = sheet.getRange(headerRow, bednaCol).getValue();

  if (existing !== 'Bedna') {
    sheet.getRange(headerRow, bednaCol).setValue('Bedna');
    Logger.log('Přidán sloupec Bedna v col ' + bednaCol);
  }

  return { celkemCol: celkemCol, bednaCol: bednaCol };
}

function ensureBednaColumn(sheet) {
  return findCelkemAndBednaCols(sheet).bednaCol;
}

function computeRowTotal(sheet, row, bednaCol) {
  const originalVals = sheet.getRange(row, 5, 1, 9).getValues()[0];
  let total = originalVals.reduce((sum, v) => sum + (Number(v) || 0), 0);
  if (bednaCol > 0) {
    const bednaVal = sheet.getRange(row, bednaCol).getValue();
    total += Number(bednaVal) || 0;
  }
  return total;
}

// Průběžný/periodický zápis dnešních dat ze Firebase do Sheets.
// Běží každých 15 minut (viz createTriggers). Vždy přepočítá celý dnešní
// řádek znovu z Firebase, takže je to samoopravné a bezpečné i při souběhu.
function dailyExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('dailyExport: jiný běh právě probíhá, přeskakuji.');
    return;
  }

  try {
    const todayISO = getTodayISO();
    const todaySheet = getTodaySheet();

    Logger.log('=== Export: ' + todayISO + ' ===');

    const docs = fetchTodayFirestoreRecords();
    if (!docs.length) { Logger.log('Žádné záznamy pro dnešek ve Firebase.'); return; }

    const agg = {};
    WORKERS.forEach(w => { agg[w] = {}; PALLETS.forEach(p => agg[w][p] = 0); });

    let found = 0;
    docs.forEach(doc => {
      const f = doc.fields || {};
      const workerName = parseField(f.workerName);
      const palletType = parseField(f.palletType);
      const qty = parseInt(parseField(f.qty)) || 0;

      if (!agg[workerName]) return;

      const pType = palletType && palletType.startsWith('Atypická') ? 'Atypická' : palletType;
      if (agg[workerName][pType] === undefined) return;

      agg[workerName][pType] += qty;
      found++;
    });

    Logger.log('Zpracováno záznamů: ' + found);

    const ss = SpreadsheetApp.openById(SHEET_ID);

    WORKERS.forEach(workerName => {
      const sheet = ss.getSheetByName(workerName);
      if (!sheet) { Logger.log('Sheet nenalezen: ' + workerName); return; }

      const cols = findCelkemAndBednaCols(sheet);
      const celkemCol = cols.celkemCol;
      const bednaCol = cols.bednaCol;

      const lastRow = sheet.getLastRow();
      let targetRow = -1;
      for (let r = 8; r <= lastRow; r++) {
        if (sheet.getRange(r, 1).getValue() === todaySheet) { targetRow = r; break; }
      }

      if (targetRow === -1) { Logger.log('Datum nenalezeno: ' + todaySheet); return; }

      const originalPallets = PALLETS.slice(0, 9);
      originalPallets.forEach((p, i) => {
        const val = agg[workerName][p];
        sheet.getRange(targetRow, 5 + i).setValue(val > 0 ? val : '');
      });

      if (bednaCol > 0) {
        const bednaVal = agg[workerName]['Bedna'];
        sheet.getRange(targetRow, bednaCol).setValue(bednaVal > 0 ? bednaVal : '');
      }

      if (celkemCol > 0) {
        const total = computeRowTotal(sheet, targetRow, bednaCol);
        sheet.getRange(targetRow, celkemCol).setValue(total);
      }

      Logger.log('✓ Zapsáno: ' + workerName);
    });

    Logger.log('=== Export dokončen ===');
  } catch (err) {
    sendErrorAlert('Chyba v dailyExport', err.message + '\n\n' + err.stack);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// Jednorázová oprava historických dat (proběhla 27.8.2026, ponecháno pro
// budoucí potřebu, kdyby bylo nutné znovu přepočítat historii).
function backfillCelkemAll() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let totalFixed = 0;

  WORKERS.forEach(workerName => {
    const sheet = ss.getSheetByName(workerName);
    if (!sheet) { Logger.log('Sheet nenalezen: ' + workerName); return; }

    const cols = findCelkemAndBednaCols(sheet);
    const celkemCol = cols.celkemCol;
    const bednaCol = cols.bednaCol;
    if (celkemCol === -1) { Logger.log('Přeskakuji ' + workerName + ' — sloupec Celkem nenalezen'); return; }

    const lastRow = sheet.getLastRow();
    let fixedForWorker = 0;

    for (let r = 8; r <= lastRow; r++) {
      const datum = sheet.getRange(r, 1).getValue();
      if (!datum) continue;

      const oldVal = sheet.getRange(r, celkemCol).getValue();
      const newVal = computeRowTotal(sheet, r, bednaCol);

      if (Number(oldVal) !== newVal) {
        sheet.getRange(r, celkemCol).setValue(newVal);
        fixedForWorker++;
      }
    }

    Logger.log('✓ ' + workerName + ': opraveno řádků = ' + fixedForWorker);
    totalFixed += fixedForWorker;
  });

  Logger.log('=== Backfill dokončen! Celkem opravených řádků: ' + totalFixed + ' ===');
}

function columnToLetter(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// Jednorázově doplněno 27.8.2026 — ponecháno pro budoucí referenci.
function addBednaToYearSummary() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  WORKERS.forEach(workerName => {
    const sheet = ss.getSheetByName(workerName);
    if (!sheet) { Logger.log('Sheet nenalezen: ' + workerName); return; }
    const cols = findCelkemAndBednaCols(sheet);
    const celkemCol = cols.celkemCol;
    const bednaCol = cols.bednaCol;
    if (celkemCol === -1) { Logger.log('Přeskakuji ' + workerName); return; }

    let summaryRow = -1;
    for (let r = 1; r <= 10; r++) {
      const val = sheet.getRange(r, 1).getValue();
      if (typeof val === 'string' && val.indexOf('SOUHRN ROKU') !== -1) { summaryRow = r; break; }
    }
    if (summaryRow === -1) { Logger.log('SOUHRN ROKU nenalezen pro ' + workerName); return; }

    const celkemFormula = sheet.getRange(summaryRow, celkemCol).getFormula();
    if (celkemFormula) {
      const celkemColLetter = columnToLetter(celkemCol);
      const bednaColLetter = columnToLetter(bednaCol);
      const newFormula = celkemFormula.split(celkemColLetter).join(bednaColLetter);
      sheet.getRange(summaryRow, bednaCol).setFormula(newFormula);
    } else {
      const lastRow = sheet.getLastRow();
      const vals = sheet.getRange(8, bednaCol, lastRow - 7, 1).getValues();
      const total = vals.reduce((s, row) => s + (Number(row[0]) || 0), 0);
      sheet.getRange(summaryRow, bednaCol).setValue(total);
    }
  });
}

// Lehký endpoint volaný appkou po každém potvrzeném záznamu (real-time signál).
// Záměrně NEZAPISUJE nic do Sheets — appka zapisuje reálná data přímo do
// Firebase (to je bezpečné, atomické). Do Sheets se promítnou přes dailyExport,
// který teď běží každých 15 minut. Tím mizí duplicitní/rizikové zapisování na
// dvou místech (dřív hrozila při souběžném zápisu race condition).
function doGet(e) {
  try {
    Logger.log('doGet přijal: ' + JSON.stringify(e && e.parameter));
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    sendErrorAlert('Chyba v doGet', err.message + '\n\n' + err.stack);
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Denní kontrola: porovná roční součty ve Firebase se součty ve Sheets.
// Pokud nesedí, pošle email. Odhalí i budoucí chyby podobné té s Bednou.
function reconcileFirebaseVsSheets() {
  try {
    const currentYear = String(new Date().getFullYear());
    const docs = fetchAllFirestoreRecords();

    const agg = {};
    WORKERS.forEach(w => { agg[w] = {}; PALLETS.forEach(p => agg[w][p] = 0); });

    docs.forEach(doc => {
      const f = doc.fields || {};
      const date = parseField(f.date);
      const workerName = parseField(f.workerName);
      const palletType = parseField(f.palletType);
      const qty = parseInt(parseField(f.qty)) || 0;

      if (!date || date.indexOf(currentYear) !== 0) return;
      if (!agg[workerName]) return;
      const pType = palletType && palletType.startsWith('Atypická') ? 'Atypická' : palletType;
      if (agg[workerName][pType] === undefined) return;

      agg[workerName][pType] += qty;
    });

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const mismatches = [];

    WORKERS.forEach(workerName => {
      const sheet = ss.getSheetByName(workerName);
      if (!sheet) return;
      const cols = findCelkemAndBednaCols(sheet);
      const lastRow = sheet.getLastRow();
      const numRows = lastRow - 7;
      if (numRows <= 0) return;

      const data = sheet.getRange(8, 1, numRows, sheet.getLastColumn()).getValues();
      const sums = {};

      PALLETS.forEach((p, idx) => {
        const col = (p === 'Bedna') ? cols.bednaCol : (5 + idx);
        let total = 0;
        data.forEach(row => {
          const datum = row[0];
          if (!datum) return;
          if (typeof datum === 'string' && datum.indexOf('SOUHRN') !== -1) return;
          total += Number(row[col - 1]) || 0;
        });
        sums[p] = total;
      });

      PALLETS.forEach(p => {
        const fbTotal = agg[workerName][p];
        const sheetTotal = sums[p];
        if (fbTotal !== sheetTotal) {
          mismatches.push(workerName + ' / ' + p + ': Firebase=' + fbTotal + ', Sheets=' + sheetTotal + ' (rozdíl ' + (fbTotal - sheetTotal) + ')');
        }
      });
    });

    if (mismatches.length > 0) {
      sendErrorAlert('Nesrovnalost Firebase vs Sheets', 'Denní kontrola našla rozdíly mezi Firebase a Sheets:\n\n' + mismatches.join('\n'));
      Logger.log('Reconcile: NALEZENY NESROVNALOSTI:\n' + mismatches.join('\n'));
    } else {
      Logger.log('Reconcile: vše sedí, žádné nesrovnalosti.');
    }
  } catch (err) {
    sendErrorAlert('Chyba v reconcileFirebaseVsSheets', err.message + '\n\n' + err.stack);
  }
}

// Nastaví oba triggery: dailyExport (každých 15 min) a reconcile (denně ve 22:00).
function createTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyExport').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('reconcileFirebaseVsSheets').timeBased().atHour(22).everyDays(1).create();
  Logger.log('Triggery nastaveny — dailyExport každých 15 min, reconcile denně ve 22:00');
}

function createDailyTrigger() {
  createTriggers();
}

// Plný přepočet historie ze zdroje pravdy (Firebase) do Sheets, pro aktuální rok.
// Přepíše všech 9 typů palet + Bedna + Celkem na každém řádku, kde list má datum,
// podle skutečných dat z Firebase. Spouští se ručně, s vědomím uživatele —
// přepisuje historická produkční data. Neexistující/neshodné řádky nechává být
// a nahlásí je e-mailem (nesmaže ani nevytváří řádky).
function fullHistoricalRecompute() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('fullHistoricalRecompute: jiný běh právě probíhá, přeskakuji.');
    return;
  }
  try {
    const currentYear = String(new Date().getFullYear());
    Logger.log('=== Plný přepočet historie ze zdroje pravdy (Firebase) pro rok ' + currentYear + ' ===');

    const docs = fetchAllFirestoreRecords();

    const agg = {};
    WORKERS.forEach(w => { agg[w] = {}; });

    let used = 0, skippedYear = 0, skippedWorker = 0, skippedPallet = 0;
    docs.forEach(doc => {
      const f = doc.fields || {};
      const date = parseField(f.date);
      const workerName = parseField(f.workerName);
      const palletType = parseField(f.palletType);
      const qty = parseInt(parseField(f.qty)) || 0;

      if (!date || date.indexOf(currentYear) !== 0) { skippedYear++; return; }
      if (!agg[workerName]) { skippedWorker++; return; }

      const pType = palletType && palletType.startsWith('Atypická') ? 'Atypická' : palletType;
      if (PALLETS.indexOf(pType) === -1) { skippedPallet++; return; }

      const parts = date.split('-');
      if (parts.length !== 3) return;
      const sheetDate = parts[2] + '.' + parts[1] + '.';

      if (!agg[workerName][sheetDate]) {
        agg[workerName][sheetDate] = {};
        PALLETS.forEach(p => agg[workerName][sheetDate][p] = 0);
      }
      agg[workerName][sheetDate][pType] += qty;
      used++;
    });

    Logger.log('Firebase záznamy pro rok ' + currentYear + ' — použito: ' + used + ', přeskočeno (jiný rok): ' + skippedYear + ', (neznámý pracovník): ' + skippedWorker + ', (neznámý typ palety): ' + skippedPallet);

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const originalPallets = PALLETS.slice(0, 9);
    let totalRowsUpdated = 0;
    const notFoundDates = {};

    WORKERS.forEach(workerName => {
      const sheet = ss.getSheetByName(workerName);
      if (!sheet) { Logger.log('Sheet nenalezen: ' + workerName); return; }

      const cols = findCelkemAndBednaCols(sheet);
      const celkemCol = cols.celkemCol;
      const bednaCol = cols.bednaCol;
      if (celkemCol === -1 || bednaCol !== celkemCol + 1) {
        Logger.log('Přeskakuji ' + workerName + ' — neočekávaná struktura sloupců (celkem=' + celkemCol + ', bedna=' + bednaCol + ')');
        return;
      }

      const lastRow = sheet.getLastRow();
      const numRows = lastRow - 7;
      if (numRows <= 0) return;

      const dateVals = sheet.getRange(8, 1, numRows, 1).getValues();
      const blockWidth = bednaCol - 5 + 1;
      const block = sheet.getRange(8, 5, numRows, blockWidth).getValues();
      const celkemIdx = celkemCol - 5;
      const bednaIdx = bednaCol - 5;

      const seenDates = {};
      let rowsUpdated = 0;

      for (let i = 0; i < numRows; i++) {
        const datum = dateVals[i][0];
        if (!datum || typeof datum !== 'string' || datum.indexOf('SOUHRN') !== -1) continue;

        seenDates[datum] = true;
        const rec = agg[workerName][datum];
        let total = 0;

        originalPallets.forEach((p, idx) => {
          const val = rec ? (rec[p] || 0) : 0;
          total += val;
          block[i][idx] = val > 0 ? val : '';
        });

        const bednaVal = rec ? (rec['Bedna'] || 0) : 0;
        total += bednaVal;
        block[i][bednaIdx] = bednaVal > 0 ? bednaVal : '';
        block[i][celkemIdx] = total;

        rowsUpdated++;
      }

      sheet.getRange(8, 5, numRows, blockWidth).setValues(block);

      Object.keys(agg[workerName]).forEach(d => {
        if (!seenDates[d]) {
          if (!notFoundDates[workerName]) notFoundDates[workerName] = [];
          notFoundDates[workerName].push(d);
        }
      });

      Logger.log('✓ ' + workerName + ': přepočteno řádků s datem = ' + rowsUpdated);
      totalRowsUpdated += rowsUpdated;
    });

    Logger.log('=== Přepočet dokončen. Celkem přepočtených řádků: ' + totalRowsUpdated + ' ===');

    const nfEntries = Object.keys(notFoundDates);
    if (nfEntries.length > 0) {
      let msg = 'Přepočet historie dokončen, ale pro tato data ve Firebase nebyl nalezen odpovídající řádek v listu (nezapsáno):\n\n';
      nfEntries.forEach(w => { msg += w + ': ' + notFoundDates[w].join(', ') + '\n'; });
      Logger.log(msg);
      sendErrorAlert('Přepočet historie — nenalezené řádky', msg);
    } else {
      Logger.log('Všechna data z Firebase našla odpovídající řádek v listu.');
    }
  } catch (err) {
    sendErrorAlert('Chyba v fullHistoricalRecompute', err.message + '\n\n' + err.stack);
    throw err;
  } finally {
    lock.releaseLock();
  }
}
