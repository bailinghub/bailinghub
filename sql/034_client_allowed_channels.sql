-- 百灵中枢 · 接入方「主动出站渠道白名单」（POST /send 用）。
-- 业务侧带 client token 调 /send「把这条消息经渠道X发给用户Y」时，只能发本字段授权的渠道。
-- 与 allowed_routes 同语义：JSON 数组文本，['*']=全部；NULL/空=不允许任何渠道（fail-closed，必须显式授权）。
-- database: bailinghub。初始化：npm run db:init（已记账的文件跳过；ADD COLUMN 已存在错误码被吞，可重复执行）

ALTER TABLE `bz_clients` ADD COLUMN `allowed_channels` TEXT NULL COMMENT '可主动出站的渠道白名单(JSON数组,["*"]=全部,空=禁止)' AFTER `allowed_routes`;
