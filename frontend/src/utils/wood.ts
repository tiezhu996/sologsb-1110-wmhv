import type { BoardPair, WoodBoard } from '../types/wood-board';

/** 由阴干年限推算含水率（%）：阴干越久含水率越低，收敛到 5% 左右 */
export function moisturePctOf(dryYears: number): number {
  const years = Number(dryYears) || 0;
  const pct = 14.5 - years * 1.15;
  return Number(Math.min(14.5, Math.max(5, pct)).toFixed(1));
}

/** 是否为可用板材：无裂纹且阴干 ≥ 3 年 */
export function boardUsable(board: WoodBoard): boolean {
  return board.defect !== '裂纹' && board.dryYears >= 3;
}

/** 面板与底板按琴号配对 */
export function pairBoards(boards: WoodBoard[]): BoardPair[] {
  const map = new Map<
    string,
    { panel?: WoodBoard; base?: WoodBoard; extraPanels: WoodBoard[]; extraBases: WoodBoard[] }
  >();
  boards.forEach((board) => {
    if (!board.guqinNo) return;
    const pair = map.get(board.guqinNo) ?? { extraPanels: [], extraBases: [] };
    if (board.part === '面板') {
      // 同一琴号只认一块面板，其余作为冲突板材保留并提示
      if (pair.panel) pair.extraPanels.push(board);
      else pair.panel = board;
    } else {
      if (pair.base) pair.extraBases.push(board);
      else pair.base = board;
    }
    map.set(board.guqinNo, pair);
  });

  return Array.from(map.entries())
    .map(([guqinNo, pair]): BoardPair => {
      const matched = Boolean(pair.panel && pair.base);
      const conflict = pair.extraPanels.length > 0 || pair.extraBases.length > 0;
      const years = Math.max(pair.panel?.dryYears ?? 0, pair.base?.dryYears ?? 0);
      const species: BoardPair['species'] = pair.panel?.species ?? pair.base?.species ?? '';
      return {
        guqinNo,
        panel: pair.panel,
        base: pair.base,
        extraPanels: pair.extraPanels,
        extraBases: pair.extraBases,
        species,
        moisturePct: moisturePctOf(years),
        matched,
        conflict,
      };
    })
    .sort((a, b) => a.guqinNo.localeCompare(b.guqinNo));
}

/** 面板/底板厚度差（mm），差值过大需再刨削 */
export function thicknessGap(pair: BoardPair): number {
  if (!pair.panel || !pair.base) {
    return 0;
  }
  return Number(Math.abs(pair.panel.thicknessMm - pair.base.thicknessMm).toFixed(1));
}

/** 根据已有琴号尾号推算下一个建议琴号（如 Q-2505 → Q-2506） */
export function suggestGuqinNo(guqinNos: string[]): string {
  let max = 2500;
  guqinNos.forEach((no) => {
    const matched = no.match(/(\d+)\s*$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  });
  return `Q-${max + 1}`;
}

/**
 * 换板前置校验：已经掏膛或已经髹漆的琴不允许换板。
 * 返回阻断原因列表（为空表示可以换）。
 */
export function swapBlockedReasons(chambered: boolean, lacquered: boolean): string[] {
  const reasons: string[] = [];
  if (chambered) reasons.push('该琴已经掏膛（存在槽腹记录），换板会让槽腹尺寸与实物对不上');
  if (lacquered) reasons.push('该琴已经髹漆（存在灰胎遍次记录），换板会破坏已成型的灰胎');
  return reasons;
}
