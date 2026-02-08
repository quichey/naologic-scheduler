/*
Since datasets are going to be large,
want to use this script as a way to vet and automate testing 
of the large datasets.

constraints:

-- Work Centers can only work on 1 Work Order at a time

-- Work Centers have shifts like typical companies. Work orders cannot progress when a shift is not in session

-- Work Centers have specified maintenance windows in which work orders cannot progress

-- some work orders require other work orders to be finished first

-- some Work Orders are maintenance work orders. That cannot be moved

--- question: if the work order cannot be moved, what if the duration is longer than any shifts of any work center? Does the work center continue progress on it outside of regular schedule? Do we assume this will never happen?
----- gemini says to treat these as things that happen even outside of Work Center shifts, as these are critical.

-- algorithm needs to output:

--- Output:

---- new schedule that satisfies all conditions

---- list of changes from original schedule

---- why changes occurred
*/