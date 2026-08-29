<script setup>
// 曲谱/歌词编辑：音符列表（起点/时长/音高/歌词）编辑，共享 UTAU 工程
import { ref, nextTick } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const store = useUtauStore();

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
const parsePitch = s => {
  const m = /^([A-Ga-g])(#?)(-?\d+)$/.exec(String(s).trim());
  if (!m) return null;
  let i = NOTE_NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') i = (i + 1) % 12;
  return (parseInt(m[3], 10) + 1) * 12 + i;
};

const newLyric = ref('あ');
const newPitch = ref(60);  // C4

function addNote() {
  const start = store.totalBeats;
  const id = store.addNote(start, newPitch.value);
  store.updateNote(id, { lyric: newLyric.value || 'あ' });
  nextTick(() => (newPitch.value = newPitch.value < 84 ? newPitch.value + 1 : 60));
}
function playSingles(n) { store.selectedId = n.id; }

const pitchOptions = Array.from({ length: 61 }, (_, i) => i + 36);  // C2..C7
</script>

<template>
  <div class="us">
    <div class="us-toolbar">
      <label>{{ t('BPM') }}<input type="number" class="text-input us-num" :value="store.bpm" min="20" max="400" @change="e => store.setBpm(parseFloat(e.target.value) || 120)" /></label>
      <label>{{ t('音源录制音高') }}<select class="select-input" :value="store.sampleNote" @change="e => store.setSampleNote(e.target.value)">
        <option v-for="n in pitchOptions" :key="n" :value="pitchName(n)">{{ pitchName(n) }}</option>
      </select></label>
      <button class="btn primary" @click="addNote"><Icon name="plus" :size="13" /> {{ t('添加音符') }}</button>
      <label class="us-lyric-in">{{ t('歌词') }}<input v-model="newLyric" class="text-input us-lyric" maxlength="8" /></label>
      <label>{{ t('音高') }}<select class="select-input" v-model.number="newPitch"><option v-for="n in pitchOptions" :key="n" :value="n">{{ pitchName(n) }}</option></select></label>
      <button v-if="store.notes.length" class="btn sm ghost danger" @click="store.clear()" style="margin-left:auto">{{ t('清空') }}</button>
    </div>

    <div class="us-list">
      <div v-if="!store.notes.length" class="muted small us-empty">{{ t('点击「添加音符」开始排一段曲目，然后到「调声」与「渲染」。') }}</div>
      <template v-else>
        <div class="us-row us-head">
          <span>#</span><span>{{ t('音高') }}</span><span>{{ t('歌词') }}</span><span>{{ t('起点(拍)') }}</span><span>{{ t('时长(拍)') }}</span><span>{{ t('力度') }}</span><span>{{ t('颤音') }}</span><span></span>
        </div>
        <div v-for="(n, i) in store.sortedNotes" :key="n.id" class="us-row" :class="{ sel: store.selectedId === n.id }" @click="store.select(n.id)">
          <span class="muted">{{ i + 1 }}</span>
          <select class="select-input" :value="n.pitch" @click.stop @change="e => store.updateNote(n.id, { pitch: parseInt(e.target.value, 10) })">
            <option v-for="p in pitchOptions" :key="p" :value="p">{{ pitchName(p) }}</option>
          </select>
          <input class="text-input us-lyric" :value="n.lyric" @click.stop @input="e => store.updateNote(n.id, { lyric: e.target.value })" maxlength="8" />
          <input type="number" class="text-input us-num" :value="n.startBeat" min="0" step="0.5" @click.stop @change="e => store.updateNote(n.id, { startBeat: Math.max(0, parseFloat(e.target.value) || 0) })" />
          <input type="number" class="text-input us-num" :value="n.durBeat" min="0.25" step="0.25" @click.stop @change="e => store.updateNote(n.id, { durBeat: Math.max(0.25, parseFloat(e.target.value) || 1) })" />
          <input type="number" class="text-input us-num" :value="n.velocity" min="0" max="200" @click.stop @change="e => store.updateNote(n.id, { velocity: Math.min(200, Math.max(0, parseFloat(e.target.value) || 100)) })" />
          <span class="us-vib">{{ n.vibrato ? '≈' + n.vibDepth + '¢' : '×' }}</span>
          <button class="icon-btn" :title="t('删除')" @click.stop="store.removeNote(n.id)"><Icon name="trash" :size="12" /></button>
        </div>
      </template>
    </div>

    <div class="muted small us-hint">{{ t('调声 Tab 可微调选中音符的颤音/力度细节。') }}</div>
  </div>
</template>

<style scoped>
.us { padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
.us-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--stone); }
.us-toolbar label { display: inline-flex; align-items: center; gap: 6px; }
.us-num { width: 70px; padding: 3px 6px; font-size: 12px; }
.us-lyric-in { margin-left: 6px; }
.us-lyric { width: 88px; padding: 3px 6px; font-size: 12px; }
.us-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.us-row { display: grid; grid-template-columns: 26px 92px 100px 96px 96px 74px 60px 30px; gap: 8px; align-items: center; padding: 6px 12px; font-size: 13px; border-bottom: 1px solid var(--border); }
.us-row:last-child { border-bottom: none; }
.us-row:hover { background: var(--surface-muted); }
.us-row.sel { background: var(--brand-soft); }
.us-head { font-size: 12px; color: var(--stone); background: var(--surface-muted); }
.us-vib { color: var(--stone); font-size: 12px; }
.us-empty { padding: 20px 12px; line-height: 1.6; }
.us-hint { padding: 0 2px; line-height: 1.6; }
</style>