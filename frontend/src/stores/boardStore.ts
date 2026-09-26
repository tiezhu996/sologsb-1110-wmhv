import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { pairBoards, boardUsable, swapBlockReasons } from '../utils/wood';
import { useChamberStore } from './chamberStore';
import { useLacquerStore } from './lacquerStore';
import type { BoardPart, BoardPair, WoodBoard, WoodDefect, WoodGrain, WoodSpecies } from '../types/wood-board';

export interface BoardInput {
  /** 登记时不填琴号：板材先进待配对池，由「合成一副」统一配对 */
  guqinNo?: string;
  boardNo: string;
  part: BoardPart;
  species: WoodSpecies;
  dryYears: number;
  thicknessMm: number;
  grain: WoodGrain;
  defect: WoodDefect;
  receivedAt?: string;
  remark?: string;
}

/** 配对 / 换板动作结果：ok=false 时 message 为给用户看的原因，conflict 为冲突板材 */
export interface BoardOpResult {
  ok: boolean;
  message: string;
  conflict?: WoodBoard;
}

interface BoardState {
  boards: WoodBoard[]
  hydrated: boolean;
}

/** 板材与面板/底板配对 */
export const useBoardStore = defineStore('board', {
  state: (): BoardState => ({ boards: [], hydrated: false }),

  getters: {
    /** 面板与底板按琴号配对并回显含水率（不含待配对板材） */
    pairs(state): BoardPair[] {
      return pairBoards(state.boards);
    },
    /** 尚未配对的板材（待配对池） */
    unpairedBoards(state): WoodBoard[] {
      return state.boards.filter((b) => !b.guqinNo?.trim());
    },
    /** 可用板材数（无裂纹且阴干达标） */
    usableCount(state): number {
      return state.boards.filter(boardUsable).length;
    },
    /** 已占用的琴号（待配对板材不计） */
    guqinNos(state): string[] {
      return Array.from(new Set(state.boards.map((b) => b.guqinNo).filter(Boolean))).sort();
    },
    boardsOf(state) {
      return (guqinNo: string): WoodBoard[] => state.boards.filter((b) => b.guqinNo === guqinNo);
    },
  },

  actions: {
    async hydrate() {
      this.boards = await db.boards.orderBy('boardNo').toArray();
      this.hydrated = true;
    },

    async addBoard(input: BoardInput): Promise<WoodBoard> {
      const board: WoodBoard = {
        id: uid('board'),
        boardNo: input.boardNo.trim(),
        guqinNo: input.guqinNo?.trim() ?? '',
        part: input.part,
        species: input.species,
        dryYears: Number(input.dryYears) || 0,
        thicknessMm: Number(input.thicknessMm) || 0,
        grain: input.grain,
        defect: input.defect,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      await db.boards.put(toPlain(board));
      this.boards = [board, ...this.boards];
      return board;
    },

    async updateBoard(id: string, patch: Partial<BoardInput>) {
      const current = this.boards.find((b) => b.id === id);
      if (!current) return;
      // 琴号只能通过「合成一副 / 换板 / 退回待配对」改动，编辑表单不接受手填琴号
      const { guqinNo: _ignored, ...fields } = patch;
      const next: WoodBoard = { ...current, ...fields };
      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === id ? next : b));
    },

    async removeBoard(id: string) {
      await db.boards.delete(id);
      this.boards = this.boards.filter((b) => b.id !== id);
    },

    /** 同一琴号、同一部位已占用的板材（排除自身） */
    occupant(guqinNo: string, part: BoardPart, excludeId = ''): WoodBoard | undefined {
      return this.boards.find((b) => b.guqinNo === guqinNo.trim() && b.part === part && b.id !== excludeId);
    },

    /**
     * 一步配对：挑一块面板和一块底板合成一副，两块共用新琴号。
     * 任一块已配对、两块同部位、或琴号在某部位已有板材时拒绝，并指出冲突板材。
     */
    async pair(panelId: string, baseId: string, guqinNoInput: string): Promise<BoardOpResult> {
      const guqinNo = guqinNoInput.trim();
      const panel = this.boards.find((b) => b.id === panelId);
      const base = this.boards.find((b) => b.id === baseId);
      if (!panel || !base) return { ok: false, message: '请选择一块面板和一块底板' };
      if (panel.part !== '面板' || base.part !== '底板') {
        return { ok: false, message: '合成一副需要一块面板与一块底板' };
      }
      if (panel.id === base.id) return { ok: false, message: '不能选择同一块板材' };
      if (!guqinNo) return { ok: false, message: '请输入或选择琴号' };
      if (panel.guqinNo) return { ok: false, message: `面板 ${panel.boardNo} 已属于琴号 ${panel.guqinNo}，请先退回待配对`, conflict: panel };
      if (base.guqinNo) return { ok: false, message: `底板 ${base.boardNo} 已属于琴号 ${base.guqinNo}，请先退回待配对`, conflict: base };

      const panelConflict = this.occupant(guqinNo, '面板');
      if (panelConflict) {
        return { ok: false, message: `琴号 ${guqinNo} 的面板位已被 ${panelConflict.boardNo} 占用，不能再放第二块面板`, conflict: panelConflict };
      }
      const baseConflict = this.occupant(guqinNo, '底板');
      if (baseConflict) {
        return { ok: false, message: `琴号 ${guqinNo} 的底板位已被 ${baseConflict.boardNo} 占用，不能再放第二块底板`, conflict: baseConflict };
      }

      const updated = [panel, base].map((b) => ({ ...b, guqinNo }));
      for (const board of updated) {
        await db.boards.put(toPlain(board));
      }
      this.boards = this.boards.map((b) => updated.find((u) => u.id === b.id) ?? b);
      return { ok: true, message: `已合成一副：${panel.boardNo} + ${base.boardNo} → 琴号 ${guqinNo}` };
    },

    /**
     * 补齐半成品：待配对板材直接占用琴号上尚空缺的部位。
     * 与换板的区别：不顶替任何板材，因此不受掏膛/髹漆限制；
     * 该部位若其实已有板材，仍按冲突拒绝并指出是谁。
     */
    async assignBoard(guqinNoInput: string, boardId: string): Promise<BoardOpResult> {
      const guqinNo = guqinNoInput.trim();
      const board = this.boards.find((b) => b.id === boardId);
      if (!board) return { ok: false, message: '请选择要配对的板材' };
      if (!guqinNo) return { ok: false, message: '请输入琴号' };
      if (board.guqinNo) {
        return { ok: false, message: `${board.boardNo} 已属于琴号 ${board.guqinNo}，请先退回待配对`, conflict: board };
      }
      const conflict = this.occupant(guqinNo, board.part);
      if (conflict) {
        return {
          ok: false,
          message: `琴号 ${guqinNo} 的${board.part}位已被 ${conflict.boardNo} 占用，不能再放第二块${board.part}`,
          conflict,
        };
      }
      const next = { ...board, guqinNo };
      await db.boards.put(toPlain(next));
      this.boards = this.boards.map((b) => (b.id === next.id ? next : b));
      return { ok: true, message: `已补齐：${board.boardNo} 配入琴号 ${guqinNo}（${board.part}）` };
    },

    /** 换板前的禁止原因（已经掏膛或已经髹漆的琴不让换） */
    swapBlockedReasons(guqinNo: string): string[] {
      return swapBlockReasons(guqinNo, useChamberStore().chambers, useLacquerStore().layers);
    },

    /**
     * 换板：新板（必须来自待配对池且部位一致）接管琴号，
     * 原同部位板材清空琴号、退回待配对。已经掏膛或髹漆的琴先不让换。
     */
    async replaceBoard(guqinNoInput: string, newBoardId: string): Promise<BoardOpResult> {
      const guqinNo = guqinNoInput.trim();
      const replacement = this.boards.find((b) => b.id === newBoardId);
      if (!replacement) return { ok: false, message: '请选择要换上的板材' };
      if (replacement.guqinNo) {
        return { ok: false, message: `${replacement.boardNo} 已属于琴号 ${replacement.guqinNo}，换板只能使用待配对板材`, conflict: replacement };
      }

      const reasons = this.swapBlockedReasons(guqinNo);
      if (reasons.length) {
        return { ok: false, message: `琴号 ${guqinNo} 暂不能换板：${reasons.join('；')}` };
      }

      const occupant = this.occupant(guqinNo, replacement.part);
      if (!occupant) {
        return { ok: false, message: `琴号 ${guqinNo} 下没有${replacement.part}，请改用「合成一副 / 补齐」` };
      }

      const takeOver = { ...replacement, guqinNo };
      const released = { ...occupant, guqinNo: '' };
      await db.boards.put(toPlain(takeOver));
      await db.boards.put(toPlain(released));
      this.boards = this.boards.map((b) => {
        if (b.id === takeOver.id) return takeOver;
        if (b.id === released.id) return released;
        return b;
      });
      return {
        ok: true,
        message: `已换板：${takeOver.boardNo} 接管琴号 ${guqinNo}，原${replacement.part} ${released.boardNo} 已退回待配对`,
      };
    },

    /** 把板材退回待配对池（清空琴号） */
    async releaseBoard(id: string): Promise<BoardOpResult> {
      const board = this.boards.find((b) => b.id === id);
      if (!board) return { ok: false, message: '板材不存在' };
      if (!board.guqinNo) return { ok: false, message: `${board.boardNo} 本就在待配对池中` };
      const released = { ...board, guqinNo: '' };
      await db.boards.put(toPlain(released));
      this.boards = this.boards.map((b) => (b.id === id ? released : b));
      return { ok: true, message: `板材 ${board.boardNo} 已退回待配对` };
    },
  },
});
