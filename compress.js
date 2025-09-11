function encodeNumber(num) {
  const safeChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~';
  if (num <= 64) {
    // Числа 1-64 кодируем одним символом
    return safeChars[num - 1];
  } else {
    // Числа 65-300 кодируем двумя символами
    const offset = num - 65;
    const firstChar = safeChars[Math.floor(offset / 64)];
    const secondChar = safeChars[offset % 64];
    return firstChar + secondChar;
  }
}

function decodeNumber(encoded) {
  const safeChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~';

  if (encoded.length === 1) {
    const index = safeChars.indexOf(encoded);
    return index !== -1 ? index + 1 : NaN;
  } else if (encoded.length === 2) {
    const firstIndex = safeChars.indexOf(encoded[0]);
    const secondIndex = safeChars.indexOf(encoded[1]);

    if (firstIndex !== -1 && secondIndex !== -1) {
      return 65 + firstIndex * 64 + secondIndex;
    }
  }
  return NaN;
}

function serialize(numberSet) {
  if (!numberSet || numberSet.size === 0) return '';

  const numbers = Array.from(numberSet).sort((a, b) => a - b);
  const ranges = [];
  let start = numbers[0];
  let end = numbers[0];

  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] === end + 1) {
      end = numbers[i];
    } else {
      ranges.push([start, end]);
      start = numbers[i];
      end = numbers[i];
    }
  }
  ranges.push([start, end]);

  let result = '';
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeStart === rangeEnd) {
      result += encodeNumber(rangeStart);
    } else {
      result += encodeNumber(rangeStart) + '-' + encodeNumber(rangeEnd);
    }
    result += ',';
  }

  return result.slice(0, -1);
}

function deserialize(serialized) {
  if (!serialized) return new Set();

  const result = new Set();
  const parts = serialized.split(',');

  for (const part of parts) {
    if (part.includes('-')) {
      const [startEnc, endEnc] = part.split('-');
      const start = decodeNumber(startEnc);
      const end = decodeNumber(endEnc);

      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) {
          result.add(i);
        }
      }
    } else {
      const num = decodeNumber(part);
      if (!isNaN(num)) {
        result.add(num);
      }
    }
  }

  return result;
}


function arraysEqual(arr1, arr2) {
  return arr1.length === arr2.length && arr1.every((val, idx) => val === arr2[idx]);
}

function generateRandomNumbers(count, max = 300) {
  const numbers = new Set();

  if (count >= max) {
    for (let i = 1; i <= max; i++) {
      numbers.add(i);
    }
    return numbers;
  }

  const availableNumbers = Array.from({ length: max }, (_, i) => i + 1);

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * availableNumbers.length);
    numbers.add(availableNumbers[randomIndex]);
    availableNumbers.splice(randomIndex, 1);
  }

  return numbers;
}

function runTests() {
  console.log('=== ТЕСТИРОВАНИЕ АЛГОРИТМА СЖАТИЯ ===\n');

  const tests = [
    { name: '1-5 последовательно', set: new Set([1, 2, 3, 4, 5]) },
    { name: 'Разрозненные числа', set: new Set([1, 50, 100, 150, 200, 250, 300]) },
    { name: 'Граничные значения', set: new Set([1, 94, 95, 96, 300]) },
    { name: 'Случайные 50 чисел', set: generateRandomNumbers(50) },
    { name: 'Случайные 100 чисел', set: generateRandomNumbers(100) },
    { name: 'Случайные 500 чисел', set: generateRandomNumbers(500) },
    { name: 'Все 1-значные', set: new Set(Array.from({ length: 9 }, (_, i) => i + 1)) },
    { name: 'Все 2-значные', set: new Set(Array.from({ length: 90 }, (_, i) => i + 10)) },
    { name: 'Все 3-значные', set: new Set(Array.from({ length: 201 }, (_, i) => i + 100)) },
    { name: 'Полный диапазон', set: new Set(Array.from({ length: 300 }, (_, i) => i + 1)) },
    // Тесты на множество из более чем 300 чисел не имеют смысла, потому что не будут содержать более 300 уникальных элементов
  ];

  const results = [];

  for (const test of tests) {
    const originalSet = test.set;
    const simpleSerialized = Array.from(originalSet).sort((a, b) => a - b).join(',');
    const compressed = serialize(originalSet);
    const decompressed = deserialize(compressed);

    const originalSorted = Array.from(originalSet).sort((a, b) => a - b);
    const decompressedSorted = Array.from(decompressed).sort((a, b) => a - b);

    const hasNaN = decompressedSorted.some(num => isNaN(num));
    if (hasNaN) {
      throw new Error("Алгоритм дал сбой")
    }
    const isCorrect = !hasNaN &&
      originalSorted.length === decompressedSorted.length &&
      originalSorted.every((val, idx) => val === decompressedSorted[idx]);

    const compressionRatio = compressed.length / simpleSerialized.length;
    const compressionPercent = (1 - compressionRatio) * 100;

    results.push({
      'Тест': test.name,
      'Количество чисел': originalSet.size,
      'Исходный размер': simpleSerialized.length,
      'Сжатый размер': compressed.length,
      'Коэффициент сжатия': (1 / compressionRatio).toFixed(3) + 'x',
      'Сжатие %': compressionPercent.toFixed(1) + '%',
      'Корректность': isCorrect ? '✓' : '✗',
    });
  }

  console.table(results);

  console.log('\n=== ПРОВЕРКА ВСЕХ ЧИСЕЛ ===');
  const verificationResults = [];

  for (let i = 1; i <= 300; i++) {
    const encoded = encodeNumber(i);
    const decoded = decodeNumber(encoded);
    const isOk = decoded === i && !isNaN(decoded);

    if (!isOk) {
      allCorrect = false;
      verificationResults.push({
        'Число': i,
        'Закодировано': encoded,
        'Декодировано': decoded,
        'Статус': isOk ? '✓' : '✗'
      });
    }
  }

  if (verificationResults.length > 0) {
    console.table(verificationResults.slice(0, 10));
    if (verificationResults.length > 10) {
      console.log(`... и еще ${verificationResults.length - 10} ошибок`);
    }
  } else {
    console.log('Все числа 1-300 кодируются корректно: ✓');
  }
}

runTests();
