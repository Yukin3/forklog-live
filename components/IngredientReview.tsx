import { StyleSheet } from 'react-native';
import { space } from '@/constants/theme';
import { Body, Button, Card, Chip, Muted } from './ui';
import { RESTRICTIONS, type IngredientReminder } from '@/lib/restrictions';
export function IngredientReview({ reminders, preliminary = false, acknowledged = false, onAcknowledge, onLeave }: {
  reminders: IngredientReminder[]; preliminary?: boolean; acknowledged?: boolean; onAcknowledge?: () => void; onLeave?: () => void;
}) {
  if (!reminders.length) return null;
  return <Card>
    <Body bold>{preliminary ? 'Preliminary caption matches' : 'Ingredient review needed'}</Body>
    {reminders.map((r, i) => <Muted key={i} size={14}>{r.ingredient} → {RESTRICTIONS[r.restriction]}{r.omitted ? ' (intentionally omitted in recipe; actual food still needs review)' : ''}: {r.reason}</Muted>)}
    <Muted size={14}>{preliminary ? 'Caption matches are preliminary. Actual ingredients remain unknown until extraction.' : 'Limited name/alias reminders, not a safety assessment. Unmatched ingredients and cross-contact remain unchecked. Read complete packaging labels; ask the source about uncertain ingredients.'}</Muted>
    {!preliminary && <>
      {acknowledged ? <Chip label="Review acknowledged; no safety guarantee" tone="warn" /> : <Button style={s.wrapButton} title="Continue with review acknowledgement" onPress={onAcknowledge} />}
      <Button style={s.wrapButton} title="Remove matched items (unavailable)" variant="ghost" disabled />
      <Muted size={13}>Physical removal is disabled. Omit/undo is a separate recipe choice and does not establish food safety.</Muted>
      {onLeave && <Button style={s.wrapButton} title="Keep for review / leave" variant="ghost" onPress={onLeave} />}
    </>}
  </Card>;
}

const s = StyleSheet.create({
  wrapButton: { flexDirection: 'column', paddingVertical: space.sm },
});
