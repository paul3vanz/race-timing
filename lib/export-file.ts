import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Alert } from 'react-native';

import { buildRawCsv, csvFileSlug, type RawExportInput } from './raw-export';

// Writes a CSV into the app's documents folder and opens the share sheet
// (save to Files, email, Drive...). Works with no signal: saving to the phone
// needs no network.
export async function shareCsv(fileName: string, csv: string, dialogTitle: string): Promise<void> {
  const file = new File(Paths.document, fileName);
  file.write(csv);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/csv',
      dialogTitle,
      UTI: 'public.comma-separated-values-text',
    });
  } else {
    Alert.alert('Saved', `Saved to:\n${file.uri}`);
  }
}

// Reads straight from SQLite with plain SELECT * queries (no joins, no results
// merging) so it still works when something else in the app is broken.
// Participants are a nice-to-have for names, so a failure there is ignored.
export async function loadRawExportInput(db: SQLiteDatabase, raceId: string): Promise<RawExportInput> {
  const race = await db.getFirstAsync<RawExportInput['race']>('SELECT * FROM races WHERE id = ?', [raceId]);
  const taps = await db.getAllAsync<RawExportInput['taps'][number]>(
    'SELECT * FROM timestamps WHERE race_id = ?',
    [raceId],
  );
  const finishes = await db.getAllAsync<RawExportInput['finishes'][number]>(
    'SELECT * FROM finishes WHERE race_id = ?',
    [raceId],
  );
  let participants: NonNullable<RawExportInput['participants']> = [];
  try {
    participants = await db.getAllAsync<(typeof participants)[number]>(
      'SELECT * FROM participants WHERE race_id = ?',
      [raceId],
    );
  } catch {
    // names are optional
  }
  return { race, taps, finishes, participants };
}

export async function exportRawData(db: SQLiteDatabase, raceId: string): Promise<void> {
  try {
    const input = await loadRawExportInput(db, raceId);
    if (input.taps.length === 0 && input.finishes.length === 0) {
      Alert.alert('Nothing to export', 'No taps or bibs have been recorded for this race on this phone.');
      return;
    }
    await shareCsv(`${csvFileSlug(input.race?.name)}-raw-data.csv`, buildRawCsv(input), 'Export raw data');
  } catch (e) {
    Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
  }
}
