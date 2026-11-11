#include <dlfcn.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void OgaTokenizer;
typedef void OgaSequences;
typedef void OgaResult;
static const char *(*result_error)(const OgaResult *);
static void check(OgaResult *result) {
  if (result) { fprintf(stderr, "%s\n", result_error(result)); exit(1); }
}
#define LOAD(name, result, arguments) \
  result (*name) arguments = dlsym(library, #name); \
  if (!name) { fprintf(stderr, "Missing tokenizer symbol: %s\n", #name); return 1; }

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  setenv("ORT_DISABLE_TELEMETRY", "1", 1);
  void *library = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
  if (!library) { fprintf(stderr, "%s\n", dlerror()); return 1; }
  result_error = dlsym(library, "OgaResultGetError");
  if (!result_error) return 1;
  LOAD(OgaCreateTokenizerFromPath, OgaResult *, (const char *, OgaTokenizer **));
  LOAD(OgaCreateSequences, OgaResult *, (OgaSequences **));
  LOAD(OgaTokenizerEncode, OgaResult *, (const OgaTokenizer *, const char *, OgaSequences *));
  LOAD(OgaSequencesGetSequenceCount, size_t, (const OgaSequences *, size_t));
  LOAD(OgaSequencesGetSequenceData, const int32_t *, (const OgaSequences *, size_t));
  LOAD(OgaTokenizerDecode, OgaResult *, (const OgaTokenizer *, const int32_t *, size_t, const char **));
  LOAD(OgaDestroyString, void, (const char *));
  LOAD(OgaDestroySequences, void, (OgaSequences *));
  LOAD(OgaDestroyTokenizer, void, (OgaTokenizer *));
  LOAD(OgaShutdown, void, (void));
  LOAD(OgaSetTelemetryEnabled, void, (bool));
  OgaSetTelemetryEnabled(false);
  OgaTokenizer *tokenizer;
  check(OgaCreateTokenizerFromPath(argv[1], &tokenizer));
  unsigned char header[5];
  while (fread(header, 1, sizeof(header), stdin) == sizeof(header)) {
    uint32_t length;
    memcpy(&length, header + 1, sizeof(length));
    if (length > 4 * 1024 * 1024) return 1;
    char *input = malloc(length + 1);
    if (!input || fread(input, 1, length, stdin) != length) return 1;
    input[length] = '\0';
    if (header[0] == 'E') {
      OgaSequences *sequences;
      check(OgaCreateSequences(&sequences));
      check(OgaTokenizerEncode(tokenizer, input, sequences));
      size_t count = OgaSequencesGetSequenceCount(sequences, 0);
      const int32_t *ids = OgaSequencesGetSequenceData(sequences, 0);
      uint32_t bytes = count * sizeof(int32_t);
      fwrite(&bytes, 1, sizeof(bytes), stdout);
      fwrite(ids, 1, bytes, stdout);
      OgaDestroySequences(sequences);
    } else if (header[0] == 'D' && length % sizeof(int32_t) == 0) {
      const char *decoded;
      check(OgaTokenizerDecode(tokenizer, (const int32_t *)input, length / sizeof(int32_t), &decoded));
      uint32_t bytes = strlen(decoded);
      fwrite(&bytes, 1, sizeof(bytes), stdout);
      fwrite(decoded, 1, bytes, stdout);
      OgaDestroyString(decoded);
    } else { free(input); return 1; }
    fflush(stdout);
    free(input);
  }
  OgaDestroyTokenizer(tokenizer);
  OgaShutdown();
  dlclose(library);
  return 0;
}
