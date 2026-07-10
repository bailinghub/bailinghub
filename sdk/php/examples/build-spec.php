<?php

declare(strict_types=1);

/**
 * 构建 spec 的 CLI（CI 部署后跑它落盘，或直接 > public/.well-known/bailing/tools.json）。
 * 用法：php examples/build-spec.php > tools.json
 * 无 composer 环境也能跑（手动 require src）。
 */

require __DIR__ . '/../src/Attributes/AiTool.php';
require __DIR__ . '/../src/Attributes/AiParam.php';
require __DIR__ . '/../src/SpecBuilder.php';
require __DIR__ . '/DemoStaffController.php';

use Bailing\Connect\Examples\DemoStaffController;
use Bailing\Connect\SpecBuilder;

$builder = (new SpecBuilder(title: '演示业务系统', version: '1.0.0'))
    ->authzProbe('/.well-known/bailing/authz-probe')
    ->addClass(DemoStaffController::class);
echo $builder->buildJson();
echo "\n";
// 警告打到 stderr：不污染 stdout 的 spec，CI 日志里可见
foreach ($builder->warnings() as $w) {
    fwrite(STDERR, "[警告] {$w}\n");
}
