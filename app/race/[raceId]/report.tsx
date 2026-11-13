import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, Share, StyleSheet, Switch, Text, Pressable, View } from 'react-native';

import { useRaceSync } from '@/hooks/use-race-sync';
import {
  getEventForRace,
  getFinishesByRace,
  getParticipantsByRace,
  getRace,
  getTimestampsByRace,
  type Event,
  type Finish,
  type Participant,
  type Race,
  type Timestamp,
} from '@/lib/db';
import { buildModel, computeFinishers } from '@/lib/merge';
import { buildPrizeReport, reportToText, type RankedFinisher } from '@/lib/report';

const mono = Platform.select({ ios: 'ui-monospace', default: 'monospace' });

function PlaceRow({ place, runner }: { place: number; runner: RankedFinisher }) {
  return (
    <View style={styles.placeRow}>
      <Text style={styles.place}>{place}</Text>
      <View style={styles.placeInfo}>
        <Text style={styles.placeName} numberOfLines={1}>{runner.name}</Text>
        <Text style={styles.placeMeta} numberOfLines={1}>
          #{runner.bib}
          {runner.club ? ` · ${runner.club}` : ''}
          {runner.categoryLabel ? ` · ${runner.categoryLabel}` : ''}
          {` · overall ${runner.overallPosition}`}
        </Text>
      </View>
      <Text style={styles.placeTime}>{runner.timeLabel}</Text>
    </View>
  );
}

export default function ReportScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const db = useSQLiteContext();

  const [race, setRace] = useState<Race | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [taps, setTaps] = useState<Timestamp[]>([]);
  const [finishes, setFinishes] = useState<Finish[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [noDoublePrizes, setNoDoublePrizes] = useState(false);

  const load = useCallback(async () => {
    const [r, e, t, f, p] = await Promise.all([
      getRace(db, raceId),
      getEventForRace(db, raceId),
      getTimestampsByRace(db, raceId),
      getFinishesByRace(db, raceId),
      getParticipantsByRace(db, raceId),
    ]);
    setRace(r);
    setEvent(e);
    setTaps(t);
    setFinishes(f);
    setParticipants(p);
  }, [db, raceId]);

  useEffect(() => { load(); }, [load]);
  // Pull the latest from the other devices while the prize giving is being
  // sorted out, so a bib corrected on another phone shows up here.
  const sync = useRaceSync(raceId, load, 15_000);

  const report = useMemo(() => {
    const finishers = computeFinishers(buildModel(taps, finishes), race?.start_time ?? 0);
    return buildPrizeReport(finishers, participants, { excludeOverallFromCategories: noDoublePrizes });
  }, [taps, finishes, participants, race?.start_time, noDoublePrizes]);

  const raceName = race?.name ?? event?.name ?? 'Race';
  const hasRoster = participants.length > 0;
  const hasProblems =
    report.duplicateBibs.length > 0 || report.notOnStartList.length > 0 || event?.status !== 'finished';

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Prize giving',
          headerStyle: { backgroundColor: '#0d0d0d' },
          headerTintColor: '#fff',
          headerRight: () => (
            <Pressable
              style={styles.shareBtn}
              onPress={() => Share.share({ message: reportToText(raceName, report) })}
            >
              <Text style={styles.shareBtnText}>Share</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.race}>{raceName}</Text>
        <Text style={styles.sub}>
          {report.totalFinishers} {report.totalFinishers === 1 ? 'finisher' : 'finishers'}
          {sync.configured && sync.lastSyncedAt ? ' · up to date' : ''}
        </Text>

        {hasProblems && (
          <View style={styles.warnBox}>
            {event?.status !== 'finished' && (
              <Text style={styles.warnText}>The race has not been stopped yet, so results may still change.</Text>
            )}
            {report.duplicateBibs.length > 0 && (
              <Text style={styles.warnText}>
                Bib {report.duplicateBibs.join(', ')} appears more than once. Only the earliest counts here. Fix it on Results first.
              </Text>
            )}
            {report.notOnStartList.length > 0 && (
              <Text style={styles.warnText}>
                Not on the start list: bib {report.notOnStartList.join(', ')}. These cannot be placed in a gender or category.
              </Text>
            )}
          </View>
        )}

        {!hasRoster && (
          <View style={styles.warnBox}>
            <Text style={styles.warnText}>
              No start list loaded, so there is no gender or category to rank by. Import participants in Setup.
            </Text>
          </View>
        )}

        <View style={styles.optionRow}>
          <View style={styles.optionText}>
            <Text style={styles.optionTitle}>No double prizes</Text>
            <Text style={styles.optionSub}>Overall podium finishers skip the category prizes</Text>
          </View>
          <Switch value={noDoublePrizes} onValueChange={setNoDoublePrizes} />
        </View>

        <Text style={styles.sectionTitle}>Overall male</Text>
        <View style={styles.card}>
          {report.male.length === 0 ? (
            <Text style={styles.none}>No male finishers recorded</Text>
          ) : (
            report.male.map((r, i) => <PlaceRow key={r.bib} place={i + 1} runner={r} />)
          )}
        </View>

        <Text style={styles.sectionTitle}>Overall female</Text>
        <View style={styles.card}>
          {report.female.length === 0 ? (
            <Text style={styles.none}>No female finishers recorded</Text>
          ) : (
            report.female.map((r, i) => <PlaceRow key={r.bib} place={i + 1} runner={r} />)
          )}
        </View>

        <Text style={styles.sectionTitle}>Category winners</Text>
        <View style={styles.card}>
          {report.categories.length === 0 ? (
            <Text style={styles.none}>No categories on the start list</Text>
          ) : (
            report.categories.map((c) => (
              <View key={c.label} style={styles.categoryBlock}>
                <Text style={styles.categoryLabel}>{c.label}</Text>
                <PlaceRow place={1} runner={c.winner} />
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d0d0d' },
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  race: { color: '#fff', fontSize: 24, fontWeight: '700' },
  sub: { color: '#666', fontSize: 14, marginBottom: 4 },
  warnBox: {
    backgroundColor: '#1a1400',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#5c4a10',
    padding: 12,
    gap: 6,
  },
  warnText: { color: '#d9a93a', fontSize: 13, lineHeight: 18 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  optionText: { flex: 1, gap: 2 },
  optionTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  optionSub: { color: '#777', fontSize: 12 },
  sectionTitle: { color: '#4caf50', fontSize: 13, fontWeight: '700', marginTop: 12, textTransform: 'uppercase', letterSpacing: 1 },
  card: { backgroundColor: '#141414', borderRadius: 12, overflow: 'hidden' },
  none: { color: '#555', fontSize: 14, padding: 14 },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
  },
  place: { color: '#4caf50', fontFamily: mono, fontSize: 20, fontWeight: '800', width: 24, textAlign: 'center' },
  placeInfo: { flex: 1, gap: 2 },
  placeName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  placeMeta: { color: '#777', fontSize: 12 },
  placeTime: { color: '#ddd', fontFamily: mono, fontSize: 15, fontWeight: '600' },
  categoryBlock: { borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  categoryLabel: { color: '#aaa', fontSize: 12, fontWeight: '700', paddingHorizontal: 14, paddingTop: 10 },
  shareBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1b5e20', borderRadius: 8, marginRight: 4 },
  shareBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
