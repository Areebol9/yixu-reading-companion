package com.yixu.reading;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class ReadingSourceCheck {
    static void check(boolean value,String description){if(!value)throw new AssertionError(description);}
    public static void main(String[] args){
        ReadingSource q=ReadingSource.QIDIAN,l=ReadingSource.LEGADO;
        Set<String> ids=new HashSet<>(Arrays.asList("qd_reader_layoutRoot"));
        check(q.classify(q.packageName,false,ids::contains)==1,"Qidian reading page accepted");
        check(q.classify("com.example.other",true,ids::contains)==0,"other app rejected even with matching IDs");
        ids.clear();check(q.classify(q.packageName,true,ids::contains)==0,"Qidian home/account pages rejected");
        ids.add("commentVP");check(q.classify(q.packageName,false,ids::contains)==0,"comments require a previously identified reading surface");
        check(q.classify(q.packageName,true,ids::contains)==2,"known reading comments classified separately");
        ids.clear();ids.add("read_view");check(l.classify(l.packageName,false,ids::contains)==1,"reviewed Legado reading marker accepted");
        ids.add("read_menu");check(l.classify(l.packageName,true,ids::contains)==0,"open reading menu suspends capture");
        ids.remove("read_menu");ids.add("search_menu");check(l.classify(l.packageName,true,ids::contains)==0,"search menu suspends capture");
        check(ReadingSource.find("arbitrary-package")==null,"unknown source cannot select capture target");
        check(!l.tested&&q.tested,"experimental source is not presented as tested");
        System.out.println("Reading source checks passed");
    }
}
