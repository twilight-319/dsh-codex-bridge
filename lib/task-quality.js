import { taskError } from './task-store.js'

export const QUALITY_PROFILES = ['visual', 'implementation']

export function qualityRequirements(profile) {
  if (profile === undefined) return ''
  if (!QUALITY_PROFILES.includes(profile)) throw taskError('qualityProfile 必须为 visual 或 implementation。')
  const common = '以下为现有任务的交付要求，不扩大修改范围，不新增功能，不改变模型或档位。用户原始目标、参考和限制优先；这些要求不授权测试、浏览器检查或额外模型审查。'
  const criteria = profile === 'visual'
    ? ['先确定简洁一致的构图、配色和主体比例，再实现画面；避免用装饰数量代替主体表现。', '主体特征、姿态和部件连接应清晰可信，避免遮挡、穿插或比例失衡影响识别。', '有动画时，让接触点、关节、运动方向和循环节奏一致；遵守用户要求的资源与交付格式。']
    : ['保留项目现有约定和用户已有修改，完整处理本次变更涉及的调用方与失败路径。', '围绕用户要求实现，避免无关重构和额外依赖；验证仅在用户允许的范围内执行。']
  return common + '\n' + criteria.map(x => '- ' + x).join('\n') + '\n交付时区分已实现内容、已执行验证与未确认事项；文件写入成功不等于质量验收通过。'
}
