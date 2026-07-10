<?php

declare(strict_types=1);

namespace Bailing\Connect\Attributes;

use Attribute;

/**
 * 声明工具的一个参数（可重复标注）。参数定义越细，AI 调用越准——
 * description / enum / format / default 都会原样喂给模型。
 *
 * 写接口（非 GET）必须至少声明一个参数，否则中枢不暴露该工具（不让 AI 瞎猜参数），
 * SpecBuilder 在构建期就会报错拦下。
 */
#[Attribute(Attribute::TARGET_METHOD | Attribute::IS_REPEATABLE)]
final class AiParam
{
    public function __construct(
        /** 参数名 */
        public string $name,
        /** 给 AI 看的参数说明，务必写清语义与取值习惯 */
        public string $description = '',
        /** JSON Schema 类型：string / integer / number / boolean / array */
        public string $type = 'string',
        /** 是否必填 */
        public bool $required = false,
        /** 参数位置：query / body；缺省 GET→query、其他→body */
        public ?string $in = null,
        /** 枚举取值（强约束，AI 只会传这些值） */
        public ?array $enum = null,
        /** 默认值（提示性，AI 可见） */
        public mixed $default = null,
        /** 格式提示，如 date / date-time / email */
        public ?string $format = null,
        /** type=array 时的元素类型 */
        public ?string $itemsType = null,
    ) {
    }
}
