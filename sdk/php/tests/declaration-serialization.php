<?php

declare(strict_types=1);

// An optional SDK root verifies the same cases against an extracted distribution.
$sdkRoot = isset($argv[1]) ? rtrim($argv[1], '/\\') : dirname(__DIR__);
require_once $sdkRoot . '/src/Attributes/AiTool.php';
require_once $sdkRoot . '/src/Attributes/AiParam.php';
require_once $sdkRoot . '/src/SpecBuilder.php';

use Bailing\Connect\SpecBuilder;

$checks = 0;
$errors = [];
$matrix = [];
$idempotence = [];

function serializationCheck(bool $condition, string $label): void
{
    global $checks, $errors;
    $checks++;
    if (!$condition) $errors[] = $label;
}

function generatedCapability(string $method, ?bool $readonly, ?string $risk, ?bool $idempotent = null, bool $governance = false): array
{
    static $case = 0;
    $class = 'SyntheticDeclarationCase' . ++$case;
    $arguments = [
        'description' => 'Synthetic declaration regression case',
        'scope' => 'example.record.read', 'path' => '/serialization-case',
        'method' => $method, 'name' => 'serialization_case',
    ];
    if ($readonly !== null) $arguments['readonly'] = $readonly;
    if ($risk !== null) $arguments['risk'] = $risk;
    if ($idempotent !== null) $arguments['idempotent'] = $idempotent;
    if ($governance) {
        $arguments['requiresSubject'] = true;
        $arguments['confirm'] = true;
        $arguments['confirmPrompt'] = 'Approve {record_id}';
        $arguments['confirmWhen'] = [['param' => 'record_id', 'op' => '>', 'value' => 100]];
    }
    $attributeArguments = [];
    foreach ($arguments as $key => $value) $attributeArguments[] = $key . ': ' . var_export($value, true);
    // Only fixed synthetic values are evaluated. SpecBuilder must discover and
    // instantiate the real attributes through ReflectionClass/ReflectionMethod.
    eval('class ' . $class . ' {' .
        '#[\\Bailing\\Connect\\Attributes\\AiTool(' . implode(', ', $attributeArguments) . ')]' .
        '#[\\Bailing\\Connect\\Attributes\\AiParam("record_id", type: "integer", required: true)]' .
        'public function execute(): void {} }');
    $spec = json_decode((new SpecBuilder('Synthetic declaration regression'))->addClass($class)->buildJson(false), true, 512, JSON_THROW_ON_ERROR);
    return $spec['paths']['/serialization-case'][strtolower($method)]['x-agent-capability'];
}

foreach (['GET', 'POST'] as $method) {
    foreach ([null, false, true] as $readonly) {
        foreach ([null, 'low', 'medium', 'high'] as $risk) {
            $capability = generatedCapability($method, $readonly, $risk);
            $execution = $capability['execution'] ?? [];
            $label = $method . '/readonly=' . json_encode($readonly) . '/risk=' . json_encode($risk);
            serializationCheck($capability['version'] === 1 && $capability['enabled'] === true && $capability['scope'] === 'example.record.read', $label . ': declaration identity');
            serializationCheck(array_key_exists('risk', $capability) === ($risk !== null), $label . ': risk presence');
            if ($risk !== null) serializationCheck(($capability['risk']['level'] ?? null) === $risk, $label . ': risk value');
            serializationCheck(array_key_exists('readonly', $execution) === ($readonly !== null), $label . ': readonly presence');
            if ($readonly !== null) serializationCheck(array_key_exists('readonly', $execution) && $execution['readonly'] === $readonly, $label . ': readonly value');
            serializationCheck(!array_key_exists('idempotent', $execution), $label . ': unset idempotent remains omitted');

            // ACC v1 + OpenAPI binding: explicit values win; GET is only a fallback.
            $expectedReadonly = $readonly === null ? $method === 'GET' : $readonly;
            $expectedRisk = $risk ?? ($expectedReadonly ? 'low' : 'medium');
            $wireReadonly = array_key_exists('readonly', $execution) ? $execution['readonly'] : $method === 'GET';
            $effectiveRisk = $capability['risk']['level'] ?? ($wireReadonly ? 'low' : 'medium');
            serializationCheck($effectiveRisk === $expectedRisk, $label . ': effective risk');
            $matrix[] = ['method' => $method, 'readonly' => $readonly, 'risk' => $risk, 'capability' => $capability, 'expectedRisk' => $expectedRisk, 'effectiveRisk' => $effectiveRisk];
        }
    }
    foreach ([null, false, true] as $idempotent) {
        $capability = generatedCapability($method, null, null, $idempotent);
        $execution = $capability['execution'] ?? [];
        $label = $method . '/idempotent=' . json_encode($idempotent);
        serializationCheck(array_key_exists('idempotent', $execution) === ($idempotent !== null), $label . ': presence');
        if ($idempotent !== null) serializationCheck(array_key_exists('idempotent', $execution) && $execution['idempotent'] === $idempotent, $label . ': value');
        serializationCheck(!array_key_exists('risk', $capability) && !array_key_exists('readonly', $execution), $label . ': unrelated unset fields remain omitted');
        $idempotence[] = ['method' => $method, 'idempotent' => $idempotent, 'capability' => $capability];
    }
}

$governance = generatedCapability('POST', false, 'low', false, true);
serializationCheck($governance === [
    'version' => 1, 'enabled' => true, 'scope' => 'example.record.read',
    'risk' => ['level' => 'low'],
    'approval' => ['required' => true, 'when' => [['param' => 'record_id', 'op' => '>', 'value' => 100]], 'prompt' => 'Approve {record_id}'],
    'subject' => ['required' => true],
    'execution' => ['readonly' => false, 'idempotent' => false],
], 'explicit low and false do not remove approval or subject requirements');

echo json_encode([
    'sdk' => 'php', 'phpVersion' => PHP_VERSION,
    'matrixCases' => count($matrix), 'idempotenceCases' => count($idempotence),
    'checks' => $checks, 'passed' => !$errors, 'errors' => $errors,
    'matrix' => $matrix, 'idempotence' => $idempotence,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
exit($errors ? 1 : 0);
