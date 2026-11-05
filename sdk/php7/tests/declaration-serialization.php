<?php

// Run with PHP >= 7.3. An optional SDK root verifies an extracted distribution:
// php tests/declaration-serialization.php /path/to/bailing-connect-php7
$sdkRoot = isset($argv[1]) ? rtrim($argv[1], '/\\') : dirname(__DIR__);
require_once $sdkRoot . '/src/ToolDef.php';
require_once $sdkRoot . '/src/ToolSpec.php';

use Bailing\Connect\ToolDef;
use Bailing\Connect\ToolSpec;

$checks = 0;
$errors = array();
$matrix = array();
$idempotence = array();

function serializationCheck($condition, $label)
{
    global $checks, $errors;
    $checks++;
    if (!$condition) {
        $errors[] = $label;
    }
}

function generatedCapability($method, $readonly, $risk, $idempotent = null, $governance = false)
{
    $builder = ToolSpec::create('Synthetic declaration regression')->tool(
        'serialization_case', $method, '/serialization-case', 'example.record.read',
        'Synthetic declaration regression case',
        function (ToolDef $tool) use ($method, $readonly, $risk, $idempotent, $governance) {
            if ($method === 'GET') {
                $tool->query('record_id', 'integer', true);
            } else {
                $tool->body('record_id', 'integer', true);
            }
            if ($readonly !== null) $tool->readonly($readonly);
            if ($risk !== null) $tool->risk($risk);
            if ($idempotent !== null) $tool->idempotent($idempotent);
            if ($governance) {
                $tool->requiresSubject()->confirm('Approve {record_id}')->confirmWhen(array(
                    array('param' => 'record_id', 'op' => '>', 'value' => 100),
                ));
            }
        }
    );
    // Test the actual JSON wire output, not a copied private serialization function.
    $spec = json_decode($builder->buildJson(false), true);
    if (!is_array($spec) || !isset($spec['paths']['/serialization-case'][strtolower($method)]['x-agent-capability'])) {
        throw new RuntimeException('Generator did not emit a valid ACC operation');
    }
    return $spec['paths']['/serialization-case'][strtolower($method)]['x-agent-capability'];
}

foreach (array('GET', 'POST') as $method) {
    foreach (array(null, false, true) as $readonly) {
        foreach (array(null, 'low', 'medium', 'high') as $risk) {
            $capability = generatedCapability($method, $readonly, $risk);
            $execution = isset($capability['execution']) ? $capability['execution'] : array();
            $label = $method . '/readonly=' . json_encode($readonly) . '/risk=' . json_encode($risk);
            serializationCheck($capability['version'] === 1 && $capability['enabled'] === true && $capability['scope'] === 'example.record.read', $label . ': declaration identity');
            serializationCheck(array_key_exists('risk', $capability) === ($risk !== null), $label . ': risk presence');
            if ($risk !== null) serializationCheck(isset($capability['risk']['level']) && $capability['risk']['level'] === $risk, $label . ': risk value');
            serializationCheck(array_key_exists('readonly', $execution) === ($readonly !== null), $label . ': readonly presence');
            if ($readonly !== null) serializationCheck(array_key_exists('readonly', $execution) && $execution['readonly'] === $readonly, $label . ': readonly value');
            serializationCheck(!array_key_exists('idempotent', $execution), $label . ': unset idempotent remains omitted');

            // ACC v1 + OpenAPI binding: explicit values win; GET is only a fallback.
            $expectedReadonly = $readonly === null ? $method === 'GET' : $readonly;
            $expectedRisk = $risk === null ? ($expectedReadonly ? 'low' : 'medium') : $risk;
            $wireReadonly = array_key_exists('readonly', $execution) ? $execution['readonly'] : $method === 'GET';
            $effectiveRisk = isset($capability['risk']['level']) ? $capability['risk']['level'] : ($wireReadonly ? 'low' : 'medium');
            serializationCheck($effectiveRisk === $expectedRisk, $label . ': effective risk');
            $matrix[] = array('method' => $method, 'readonly' => $readonly, 'risk' => $risk, 'capability' => $capability, 'expectedRisk' => $expectedRisk, 'effectiveRisk' => $effectiveRisk);
        }
    }
    foreach (array(null, false, true) as $idempotent) {
        $capability = generatedCapability($method, null, null, $idempotent);
        $execution = isset($capability['execution']) ? $capability['execution'] : array();
        $label = $method . '/idempotent=' . json_encode($idempotent);
        serializationCheck(array_key_exists('idempotent', $execution) === ($idempotent !== null), $label . ': presence');
        if ($idempotent !== null) serializationCheck(array_key_exists('idempotent', $execution) && $execution['idempotent'] === $idempotent, $label . ': value');
        serializationCheck(!array_key_exists('risk', $capability) && !array_key_exists('readonly', $execution), $label . ': unrelated unset fields remain omitted');
        $idempotence[] = array('method' => $method, 'idempotent' => $idempotent, 'capability' => $capability);
    }
}

$governance = generatedCapability('POST', false, 'low', false, true);
serializationCheck($governance === array(
    'version' => 1, 'enabled' => true, 'scope' => 'example.record.read',
    'risk' => array('level' => 'low'),
    'approval' => array('required' => true, 'when' => array(array('param' => 'record_id', 'op' => '>', 'value' => 100)), 'prompt' => 'Approve {record_id}'),
    'subject' => array('required' => true),
    'execution' => array('readonly' => false, 'idempotent' => false),
), 'explicit low and false do not remove approval or subject requirements');

echo json_encode(array(
    'sdk' => 'php7', 'phpVersion' => PHP_VERSION,
    'matrixCases' => count($matrix), 'idempotenceCases' => count($idempotence),
    'checks' => $checks, 'passed' => !$errors, 'errors' => $errors,
    'matrix' => $matrix, 'idempotence' => $idempotence,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
exit($errors ? 1 : 0);
