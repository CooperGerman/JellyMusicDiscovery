.PHONY: build package clean

build:
	$(MAKE) -C plugin/source build

package:
	$(MAKE) -C plugin/source package

clean:
	$(MAKE) -C plugin/source clean