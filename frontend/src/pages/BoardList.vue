<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { Warning, Switch, Link } from '@element-plus/icons-vue';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import DimensionChart from '../components/common/DimensionChart.vue';
import { useBoardStore, type BoardOpResult } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useGuqinFilter } from '../hooks/useGuqinFilter';
import { thicknessGap } from '../utils/wood';
import { formatDate } from '../utils/layer';
import {
  BOARD_PARTS,
  WOOD_DEFECTS,
  WOOD_GRAINS,
  WOOD_SPECIES,
  isPaired,
  type BoardPart,
  type BoardPair,
  type WoodBoard,
  type WoodDefect,
  type WoodGrain,
  type WoodSpecies,
} from '../types/wood-board';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const filter = useGuqinFilter();

const dialogVisible = ref(false);
const editingId = ref('');
const formRef = ref<FormInstance>();
const selectedGuqin = ref('');

interface BoardForm {
  boardNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt: string;
  remark: string;
}

const form = ref<BoardForm>({
  boardNo: '',
  part: '面板',
  species: '桐木',
  dryYears: 5,
  thicknessMm: 30,
  grain: '直纹',
  defect: '无',
  receivedAt: new Date().toISOString().slice(0, 10),
  remark: '',
});

const rules: FormRules = {
  boardNo: [{ required: true, message: '请输入板材号', trigger: 'blur' }],
};

/** 配对 / 补齐 / 换板弹窗 */
type PairMode = 'new' | 'complete' | 'replace';
const pairVisible = ref(false);
const pairMode = ref<PairMode>('new');
const pairFormRef = ref<FormInstance>();
/** 供 el-form 校验的响应式表单（琴号在补齐/换板时锁定为目标琴） */
const pairForm = reactive({ guqinNo: '' });
const panelId = ref('');
const baseId = ref('');
const replacePart = ref<BoardPart>('面板');
const replacementId = ref('');
/** 补齐弹窗中选中的待配对板材 */
const completeId = ref('');
/** 换板目标琴（补齐/换板时锁定） */
const targetPair = ref<BoardPair | null>(null);

const pairRules: FormRules = {
  guqinNo: [{ required: true, message: '请输入琴号', trigger: 'blur' }],
};

const visible = computed(() => filter.applyBoards(boardStore.boards));
const visiblePairs = computed(() => {
  const nos = new Set(visible.value.filter(isPaired).map((b) => b.guqinNo));
  return boardStore.pairs.filter((pair) => nos.has(pair.guqinNo));
});
const conflictPairs = computed(() => visiblePairs.value.filter((p) => p.extraPanels.length || p.extraBases.length));

/** 冲突清单拍平成行，供顶部红色提示逐条列出「是哪块冲突」 */
interface ConflictRow {
  guqinNo: string;
  part: BoardPart;
  occupant: WoodBoard;
  extra: WoodBoard;
}
const conflictRows = computed<ConflictRow[]>(() => {
  const rows: ConflictRow[] = [];
  conflictPairs.value.forEach((pair) => {
    pair.extraPanels.forEach((extra) => {
      if (pair.panel) rows.push({ guqinNo: pair.guqinNo, part: '面板', occupant: pair.panel, extra });
    });
    pair.extraBases.forEach((extra) => {
      if (pair.base) rows.push({ guqinNo: pair.guqinNo, part: '底板', occupant: pair.base, extra });
    });
  });
  return rows;
});

/** 待配对池：琴号筛选时不显示（它们还不属于任何琴），其余按关键字/树种过滤 */
const visibleUnpaired = computed(() => {
  if (filter.guqinNo.value) return [];
  const kw = filter.keyword.value.trim().toLowerCase();
  return boardStore.unpairedBoards.filter((b) => {
    if (filter.species.value && b.species !== (filter.species.value as WoodSpecies)) return false;
    if (kw) {
      const haystack = `${b.boardNo} ${b.species} ${b.part} ${b.remark ?? ''}`.toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });
});

const unpairedPanels = computed(() => boardStore.unpairedBoards.filter((b) => b.part === '面板'));
const unpairedBases = computed(() => boardStore.unpairedBoards.filter((b) => b.part === '底板'));
const replacementCandidates = computed(() =>
  boardStore.unpairedBoards.filter((b) => b.part === replacePart.value),
);

const pairDialogTitle = computed(() => {
  if (pairMode.value === 'new') return '合成一副（面板 + 底板）';
  if (pairMode.value === 'complete') return `补齐 ${pairForm.guqinNo} 缺失部位`;
  return `换板 · ${pairForm.guqinNo} · 替换${replacePart.value}`;
});

/** 换板被禁止的原因（掏膛 / 髹漆），键为琴号，供按钮置灰与提示 */
const blockedMap = computed(() => {
  const map = new Map<string, string[]>();
  boardStore.pairs.forEach((pair) => {
    map.set(pair.guqinNo, boardStore.swapBlockedReasons(pair.guqinNo));
  });
  return map;
});

const chartMarks = computed(() => (selectedGuqin.value ? chamberStore.marksOf(selectedGuqin.value) : []));
const chartDepth = computed(() => chamberStore.byGuqin(selectedGuqin.value)?.chamberDepth ?? 0);

function boardLabel(board: WoodBoard | undefined): string {
  if (!board) return '';
  return `${board.boardNo} · ${board.species} · ${board.thicknessMm}mm · 阴干${board.dryYears}年`;
}

function openCreate() {
  editingId.value = '';
  form.value = {
    boardNo: `MB-${Date.now().toString().slice(-4)}`,
    part: '面板',
    species: '桐木',
    dryYears: 5,
    thicknessMm: 30,
    grain: '直纹',
    defect: '无',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  };
  dialogVisible.value = true;
}

function openEdit(board: WoodBoard) {
  editingId.value = board.id;
  form.value = {
    boardNo: board.boardNo,
    part: board.part,
    species: board.species,
    dryYears: board.dryYears,
    thicknessMm: board.thicknessMm,
    grain: board.grain,
    defect: board.defect,
    receivedAt: board.receivedAt.slice(0, 10),
    remark: board.remark ?? '',
  };
  dialogVisible.value = true;
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    boardNo: form.value.boardNo,
    part: form.value.part,
    species: form.value.species,
    dryYears: Number(form.value.dryYears) || 0,
    thicknessMm: Number(form.value.thicknessMm) || 0,
    grain: form.value.grain,
    defect: form.value.defect,
    receivedAt: new Date(`${form.value.receivedAt}T09:00:00`).toISOString(),
    remark: form.value.remark,
  };
  if (editingId.value) {
    await boardStore.updateBoard(editingId.value, payload);
    ElMessage.success(`已更新板材 ${payload.boardNo}`);
  } else {
    await boardStore.addBoard(payload);
    ElMessage.success(`已登记板材 ${payload.boardNo}（${payload.part}），进入待配对池`);
  }
  dialogVisible.value = false;
}

async function remove(board: WoodBoard) {
  const confirmed = await ElMessageBox.confirm(`确认删除板材 ${board.boardNo}？`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await boardStore.removeBoard(board.id);
  ElMessage.success('已删除');
}

/** 打开「合成一副」：待配对池里挑面板、底板，给一个新琴号 */
function openPairNew() {
  pairMode.value = 'new';
  targetPair.value = null;
  pairForm.guqinNo = nextGuqinSuggestion();
  replacePart.value = '面板';
  panelId.value = unpairedPanels.value[0]?.id ?? '';
  baseId.value = unpairedBases.value[0]?.id ?? '';
  replacementId.value = '';
  completeId.value = '';
  pairVisible.value = true;
}

function nextGuqinSuggestion(): string {
  const nums = boardStore.guqinNos
    .map((no) => Number(no.replace(/\D/g, '')))
    .filter((n) => !Number.isNaN(n));
  const max = nums.length ? Math.max(...nums) : 2500;
  return `Q-${String(max + 1)}`;
}

/** 打开「补齐」：半成品琴缺哪块就从待配对池补哪块 */
function openComplete(pair: BoardPair) {
  pairMode.value = 'complete';
  targetPair.value = pair;
  pairForm.guqinNo = pair.guqinNo;
  replacePart.value = pair.panel ? '底板' : '面板';
  panelId.value = pair.panel?.id ?? '';
  baseId.value = pair.base?.id ?? '';
  completeId.value = (pair.panel ? unpairedBases.value : unpairedPanels.value)[0]?.id ?? '';
  replacementId.value = '';
  pairVisible.value = true;
}

/** 打开「换板」：新板接管琴号；掏膛/髹漆过的琴先拦住并说明原因 */
function openReplace(pair: BoardPair, part: BoardPart) {
  const reasons = blockedMap.value.get(pair.guqinNo) ?? [];
  if (reasons.length) {
    ElMessageBox.alert(reasons.map((r) => `· ${r}`).join('<br/>'), `琴号 ${pair.guqinNo} 已进入后续工序，不能换板`, {
      type: 'error',
      confirmButtonText: '知道了',
      dangerouslyUseHTMLString: true,
    });
    return;
  }
  pairMode.value = 'replace';
  targetPair.value = pair;
  pairForm.guqinNo = pair.guqinNo;
  replacePart.value = part;
  replacementId.value = replacementCandidates.value[0]?.id ?? '';
  completeId.value = '';
  panelId.value = pair.panel?.id ?? '';
  baseId.value = pair.base?.id ?? '';
  pairVisible.value = true;
}

function notifyResult(result: BoardOpResult) {
  if (result.ok) {
    ElMessage.success(result.message);
    pairVisible.value = false;
  } else {
    ElMessage({ type: 'error', message: result.message, duration: 5000, showClose: true });
  }
}

async function submitPair() {
  const ok = await pairFormRef.value?.validate().catch(() => false);
  if (!ok) return;
  if (pairMode.value === 'replace') {
    notifyResult(await boardStore.replaceBoard(pairForm.guqinNo, replacementId.value));
    return;
  }
  if (pairMode.value === 'complete') {
    // 缺底板 → 从待配对池挑一块底板补入；缺面板同理（新增空部位，不顶替旧板）
    notifyResult(await boardStore.assignBoard(pairForm.guqinNo, completeId.value));
    return;
  }
  notifyResult(await boardStore.pair(panelId.value, baseId.value, pairForm.guqinNo));
}

/** 把板材退回待配对池（明细里误占琴号 / 处理冲突时用） */
async function release(board: WoodBoard) {
  const guqinNo = board.guqinNo;
  const pair = boardStore.pairs.find((p) => p.guqinNo === guqinNo);
  const isSlotOccupant = pair?.panel?.id === board.id || pair?.base?.id === board.id;
  let tip: string;
  if (isSlotOccupant) {
    const mate = boardStore.boardsOf(guqinNo).find((b) => b.part !== board.part);
    tip = mate
      ? `该板是琴号 ${guqinNo} 的在册${board.part}，退回后这张琴将缺${board.part}（${mate.boardNo} 仍占用该琴号）。`
      : `退回后琴号 ${guqinNo} 下将没有板材。`;
  } else {
    const slot = board.part === '面板' ? pair?.panel : pair?.base;
    tip = `该板是琴号 ${guqinNo} 上多出的第二块${board.part}（在册的是 ${slot?.boardNo ?? '—'}），退回后进入待配对池，不影响现有配对。`;
  }
  const downstream = blockedMap.value.get(guqinNo) ?? [];
  if (isSlotOccupant && downstream.length) {
    tip += `注意：这张琴已进入后续工序（${downstream.join('；')}），退回后须重新补齐${board.part}，否则工序记录与实物不符。`;
  }
  const confirmed = await ElMessageBox.confirm(`确认把 ${board.boardNo} 退回待配对？${tip}`, '退回待配对', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  notifyResult(await boardStore.releaseBoard(board.id));
}
</script>

<template>
  <div>
    <h2 class="page-title">板材登记与配对</h2>
    <p class="page-desc">
      板材先登记进「待配对池」，再挑一块面板和一块底板合成一副、共用琴号；同一琴号同一部位只能有一块，冲突会直接指出是哪块板材。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">登记板材</el-button>
      <el-button type="success" :icon="Link" @click="openPairNew">合成一副</el-button>
      <el-button @click="selectedGuqin = boardStore.guqinNos[0] ?? ''">查看首张琴剖面</el-button>
    </div>

    <FilterBar
      :fields="[
        { key: 'guqin', label: '琴号', options: boardStore.guqinNos, width: 130 },
        { key: 'species', label: '树种', options: WOOD_SPECIES, width: 110 },
      ]"
      :result-count="visible.length"
      :total-count="boardStore.boards.length"
    />

    <EmptyPanel
      v-if="visible.length === 0 && visibleUnpaired.length === 0"
      description="没有符合条件的板材"
      action-text="重置筛选条件"
      @action="filter.reset()"
    />

    <template v-else>
      <el-card v-if="conflictPairs.length" shadow="never" class="block conflict-card">
        <template #header>
          <div class="card-head">
            <span><el-icon><Warning /></el-icon> 配对冲突（同一琴号同一部位出现多块板材）</span>
            <span class="card-note">配对表只取第一块，其余板材必须处理，不再静默挂在明细中</span>
          </div>
        </template>
        <el-alert
          v-for="row in conflictRows"
          :key="`conflict-${row.extra.id}`"
          class="conflict-alert"
          type="error"
          :closable="false"
          show-icon
        >
          <template #title>
            琴号 {{ row.guqinNo }}：{{ row.part }}位已被 <b>{{ row.occupant.boardNo }}</b> 占用，
            <el-tag type="danger" size="small">{{ row.extra.boardNo }}</el-tag>
            （{{ row.extra.species }}/{{ row.extra.thicknessMm }}mm）不能再作为第二块{{ row.part }}配入
            <el-button link type="primary" size="small" @click="release(row.extra)">退回待配对</el-button>
          </template>
        </el-alert>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>面板 / 底板配对（含水率回显）</span>
            <span class="card-note">换板由待配对新板接管琴号，原板退回待配对；已掏膛/髹漆的琴不可换</span>
          </div>
        </template>
        <el-table :data="visiblePairs" size="small" border>
          <el-table-column prop="guqinNo" label="琴号" width="100" />
          <el-table-column label="面板" min-width="210">
            <template #default="scope">
              <span v-if="scope.row.panel">{{ boardLabel(scope.row.panel) }}</span>
              <el-tag v-else type="danger" size="small">缺面板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="底板" min-width="210">
            <template #default="scope">
              <span v-if="scope.row.base">{{ boardLabel(scope.row.base) }}</span>
              <el-tag v-else type="danger" size="small">缺底板</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="含水率" width="90">
            <template #default="scope">{{ scope.row.moisturePct }}%</template>
          </el-table-column>
          <el-table-column label="板厚差(mm)" width="100">
            <template #default="scope">{{ thicknessGap(scope.row) }}</template>
          </el-table-column>
          <el-table-column label="配对状态" width="90">
            <template #default="scope">
              <el-tag :type="scope.row.matched ? 'success' : 'warning'" size="small">{{ scope.row.matched ? '已配对' : '待配对' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="210" fixed="right">
            <template #default="scope">
              <el-button v-if="!scope.row.matched" link type="success" @click="openComplete(scope.row)">补齐</el-button>
              <template v-if="scope.row.matched">
                <el-tooltip
                  :disabled="!(blockedMap.get(scope.row.guqinNo)?.length)"
                  :title="(blockedMap.get(scope.row.guqinNo) ?? []).join('；')"
                  placement="top"
                >
                  <span>
                    <el-button
                      link
                      type="warning"
                      :icon="Switch"
                      :disabled="Boolean(blockedMap.get(scope.row.guqinNo)?.length)"
                      @click="openReplace(scope.row, '面板')"
                    >换面板</el-button>
                  </span>
                </el-tooltip>
                <el-tooltip
                  :disabled="!(blockedMap.get(scope.row.guqinNo)?.length)"
                  :title="(blockedMap.get(scope.row.guqinNo) ?? []).join('；')"
                  placement="top"
                >
                  <span>
                    <el-button
                      link
                      type="warning"
                      :icon="Switch"
                      :disabled="Boolean(blockedMap.get(scope.row.guqinNo)?.length)"
                      @click="openReplace(scope.row, '底板')"
                    >换底板</el-button>
                  </span>
                </el-tooltip>
              </template>
              <el-button link type="primary" @click="selectedGuqin = scope.row.guqinNo">剖面</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>待配对池（{{ visibleUnpaired.length }} 块）</span>
            <el-button size="small" type="success" :disabled="!unpairedPanels.length || !unpairedBases.length" @click="openPairNew">
              合成一副
            </el-button>
          </div>
        </template>
        <el-empty v-if="!visibleUnpaired.length" :image-size="56" description="没有待配对板材：登记的板材会先进这里" />
        <el-table v-else :data="visibleUnpaired" size="small" border>
          <el-table-column prop="boardNo" label="板材号" width="120" />
          <el-table-column prop="part" label="部位" width="80" />
          <el-table-column prop="species" label="树种" width="80" />
          <el-table-column prop="dryYears" label="阴干(年)" width="90" />
          <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
          <el-table-column prop="grain" label="木纹" width="90" />
          <el-table-column prop="defect" label="缺陷" width="80" />
          <el-table-column label="入库" width="110">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
              <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>板材明细（全部在册板材）</template>
        <el-table :data="visible" size="small" border>
          <el-table-column prop="boardNo" label="板材号" width="120" />
          <el-table-column label="琴号" width="110">
            <template #default="scope">
              <el-tag v-if="scope.row.guqinNo" size="small">{{ scope.row.guqinNo }}</el-tag>
              <el-tag v-else size="small" type="info">待配对</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="part" label="部位" width="80" />
          <el-table-column prop="species" label="树种" width="80" />
          <el-table-column prop="dryYears" label="阴干(年)" width="90" />
          <el-table-column prop="thicknessMm" label="厚度(mm)" width="90" />
          <el-table-column prop="grain" label="木纹" width="90" />
          <el-table-column prop="defect" label="缺陷" width="80" />
          <el-table-column label="入库" width="110">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" />
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
              <el-button v-if="scope.row.guqinNo" link type="warning" @click="release(scope.row)">退回待配对</el-button>
              <el-button link type="danger" @click="remove(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>槽腹剖面标注（DimensionChart）</span>
            <el-select v-model="selectedGuqin" placeholder="选择琴号" clearable style="width: 160px">
              <el-option v-for="no in boardStore.guqinNos" :key="no" :label="no" :value="no" />
            </el-select>
          </div>
        </template>
        <DimensionChart v-if="chartMarks.length" :marks="chartMarks" :chamber-depth="chartDepth" :guqin-no="selectedGuqin" />
        <el-empty v-else :image-size="60" description="选择已有槽腹记录的琴号即可查看剖面标注" />
      </el-card>
    </template>

    <!-- 登记 / 编辑板材：不再手填琴号 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑板材' : '登记板材'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="板材号" prop="boardNo">
          <el-input v-model="form.boardNo" placeholder="如：MB-2511" maxlength="20" />
        </el-form-item>
        <el-form-item label="部位">
          <el-select v-model="form.part" style="width: 160px">
            <el-option v-for="part in BOARD_PARTS" :key="part" :label="part" :value="part" />
          </el-select>
        </el-form-item>
        <el-form-item label="树种">
          <el-select v-model="form.species" style="width: 160px">
            <el-option v-for="species in WOOD_SPECIES" :key="species" :label="species" :value="species" />
          </el-select>
        </el-form-item>
        <el-form-item label="阴干年限(年)">
          <el-input-number v-model="form.dryYears" :min="0" :max="60" placeholder="阴干年限" />
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="5" :max="80" :step="0.5" placeholder="厚度" />
        </el-form-item>
        <el-form-item label="木纹">
          <el-select v-model="form.grain" style="width: 160px">
            <el-option v-for="grain in WOOD_GRAINS" :key="grain" :label="grain" :value="grain" />
          </el-select>
        </el-form-item>
        <el-form-item label="缺陷">
          <el-select v-model="form.defect" style="width: 160px">
            <el-option v-for="defect in WOOD_DEFECTS" :key="defect" :label="defect" :value="defect" />
          </el-select>
        </el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="form.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="60" placeholder="产地、纹理等" />
        </el-form-item>
        <el-alert
          v-if="!editingId"
          type="info"
          :closable="false"
          title="登记后板材进入「待配对池」，请用「合成一副」与另一部位板材共用琴号，无需手敲琴号。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 合成一副 / 补齐 / 换板 -->
    <el-dialog v-model="pairVisible" :title="pairDialogTitle" width="640px">
      <el-form ref="pairFormRef" :model="pairForm" :rules="pairRules" label-width="110px">
        <el-form-item v-if="pairMode !== 'replace'" label="琴号" prop="guqinNo">
          <el-input v-model="pairForm.guqinNo" :disabled="pairMode === 'complete'" placeholder="如：Q-2506" maxlength="20" />
        </el-form-item>

        <template v-if="pairMode === 'new'">
          <el-form-item label="面板">
            <el-select v-model="panelId" placeholder="从待配对池选择面板" style="width: 420px">
              <el-option
                v-for="b in unpairedPanels"
                :key="b.id"
                :label="boardLabel(b)"
                :value="b.id"
                :disabled="!unpairedPanels.length"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="底板">
            <el-select v-model="baseId" placeholder="从待配对池选择底板" style="width: 420px">
              <el-option v-for="b in unpairedBases" :key="b.id" :label="boardLabel(b)" :value="b.id" />
            </el-select>
          </el-form-item>
          <el-alert
            v-if="!unpairedPanels.length || !unpairedBases.length"
            type="warning"
            :closable="false"
            :title="`待配对池里${!unpairedPanels.length ? '缺面板' : ''}${!unpairedBases.length ? '缺底板' : ''}，请先登记。`"
          />
          <el-alert
            v-else
            type="info"
            :closable="false"
            title="两块板材将共用此琴号；若该琴号某部位已有板材，会被拒绝并指出冲突板材。"
          />
        </template>

        <template v-else-if="pairMode === 'complete'">
          <el-form-item :label="replacePart">
            <el-select v-model="completeId" :placeholder="`从待配对池选择${replacePart}`" style="width: 420px">
              <el-option
                v-for="b in (replacePart === '面板' ? unpairedPanels : unpairedBases)"
                :key="b.id"
                :label="boardLabel(b)"
                :value="b.id"
              />
            </el-select>
          </el-form-item>
          <el-alert type="info" :closable="false" :title="`选中的${replacePart}将直接占用琴号 ${pairForm.guqinNo}，合成一副。`" />
        </template>

        <template v-else>
          <el-form-item :label="`新${replacePart}`">
            <el-select v-model="replacementId" :placeholder="`从待配对池选择${replacePart}`" style="width: 420px">
              <el-option v-for="b in replacementCandidates" :key="b.id" :label="boardLabel(b)" :value="b.id" />
            </el-select>
          </el-form-item>
          <el-alert
            type="warning"
            :closable="false"
            :title="`新${replacePart}接管琴号 ${pairForm.guqinNo}，原${replacePart} ${(replacePart === '面板' ? targetPair?.panel : targetPair?.base)?.boardNo ?? ''} 退回待配对。`"
          />
        </template>
      </el-form>
      <template #footer>
        <el-button @click="pairVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPair">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.toolbar {
  margin-bottom: 12px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.conflict-card {
  border: 1px solid #f56c6c;
}
.conflict-alert {
  margin-bottom: 8px;
}
.conflict-alert:last-child {
  margin-bottom: 0;
}
</style>
