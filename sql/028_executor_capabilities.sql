-- 028: 执行器自报能力。让控制台看得见每台执行器能跑哪些 profile（+claude 版本/标签），
-- hub 据此校验「某路由的 (target, profile) 在线池里有没有人能跑」。纯增量列（可空、无默认），drop-in。
ALTER TABLE `bz_executors`
  ADD COLUMN `capabilities` JSON NULL COMMENT '执行器自报能力：{profiles:[],claude_version,labels:[]}';
