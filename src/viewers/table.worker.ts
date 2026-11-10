import { read, utils } from 'xlsx';

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const workbook = read(event.data, { type: 'array', sheetRows: 10001, cellDates: true });
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const range = utils.decode_range(sheet['!ref'] || 'A1');
      const limited = range.e.c > 199 || range.e.r >= 10000 || Boolean(sheet['!fullref']);
      range.e.c = Math.min(range.e.c, 199);
      range.e.r = Math.min(range.e.r, 9999);
      const rows = utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
        range,
      });
      return { name, rows, limited };
    });
    self.postMessage({ sheets });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Unable to read spreadsheet.',
    });
  }
};
