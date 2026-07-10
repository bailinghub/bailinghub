-- 百灵中枢 · LLM 输入契约收敛。
-- 当前契约统一使用 target_config.input.{image,audio,file} 表达多模态输入策略；
-- 根级 vision/audio 不属于当前配置模型，保存和运行期都会剔除，这里把已存配置同步清理干净。

UPDATE `bz_routes`
  SET `target_config` = JSON_REMOVE(`target_config`, '$.vision', '$.audio')
  WHERE `target_config` IS NOT NULL
    AND (
      JSON_CONTAINS_PATH(`target_config`, 'one', '$.vision') = 1
      OR JSON_CONTAINS_PATH(`target_config`, 'one', '$.audio') = 1
    );
